/**
 * 判定流水线：预筛 → 媒体信号 → Jev 类型化决策 → 闸门 → 动作规划 → 缓存/审计。
 *
 * 所有外部依赖都是注入的（Jev 客户端、图片分析、视觉模型、审计、时钟），
 * 所以这一层可以在 Node 里用假客户端做完整的端到端单测，不需要浏览器、不需要联网。
 *
 * 召回策略（两级调用）：
 *   · 一级「预筛命中」/「只发图」→ 直接问完整五问；
 *   · 二级「预检（triage）」→ 对**没有被预筛命中**的推文也问一个廉价单问
 *     （「这是不是机器人式成人诱饵/性暗示自夸」）。这是为了解决「关键词表就是召回上限」
 *     的结构性问题：真实黄推会不断换写法（`比我好看的没我骚🔧👏`、把引流写进显示名），
 *     任何白盒词表都会漏，只有让模型先看一眼才谈得上通用性。
 *   预检命中（junk 概率高）→ 升级为完整五问；未达升级线但超过隐藏线 → 只隐藏成待确认（不动作）。
 *   预检的总量由 triage 预算与采样率控制；关掉 triage 就回到「只有候选才花钱」的 0 成本模式。
 */
import { buildJunkProbe, buildRequest, buildState, readAnswers, readJunkAnswer } from './classifier.js';
import { decide as gateDecide, describeReasons, planAccountAction, BAND } from './gate.js';
import { createFarmTracker } from './farm.js';
import { mediaSuspicion } from './media.js';
import { preScreen } from './prefilter.js';
import { RateWindow, hash32 } from './util.js';
import { CATEGORY } from './classifier.js';

const ZERO_ANSWERS = {
  adult: 0,
  solicitation: 0,
  category: CATEGORY.other,
  categoryProbabilities: null,
  categoryConfidence: 0,
  severity: 0,
  severityConfidence: 0,
};

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyStats() {
  return {
    decisions: 0,
    jevCalls: 0,
    jevErrors: 0,
    schemaInvalid: 0,
    cacheHits: 0,
    prefilters: 0,
    skips: 0,
    mediaAnalyzed: 0,
    visionCalls: 0,
    triageProbes: 0,
    triageHits: 0,
    triageEscalated: 0,
    farmHits: 0,
    categories: {},
    bands: { block: 0, hide: 0, review: 0, ignore: 0 },
    totalLatencyMs: 0,
    lastError: null,
    lastDecisionAt: 0,
  };
}

export function createPipeline(deps) {
  const {
    getSettings,
    jev = null,
    analyzeImage = null,
    classifyWithVision = null,
    auditor = null,
    now = () => Date.now(),
    random = Math.random,
    onActionCandidate = null,
  } = deps;

  const cache = new Map();
  const farmTracker = createFarmTracker();
  let farmConfigKey = '';
  const inflight = new Map();
  const stats = emptyStats();
  const jevMinute = new RateWindow(60000);
  const triageMinute = new RateWindow(60000);
  const mediaMinute = new RateWindow(60000);
  const actionHour = new RateWindow(3600000);
  let day = { key: dayKey(now()), jev: 0, actions: 0, triage: 0 };

  function rollDay(nowMs) {
    const key = dayKey(nowMs);
    if (key !== day.key) day = { key, jev: 0, actions: 0, triage: 0 };
  }

  /**
   * 缓存指纹：**任何会改变判定结果的设置**都要进来。
   * 曾经只包含 hide/dryRun，结果在弹窗里切换「自动静音/拉黑」后，
   * 已缓存的推文仍返回旧的动作类型（端到端场景 D 抓到的真实 bug）。
   */
  function fingerprint(settings) {
    return hash32(
      JSON.stringify({
        t: settings.thresholds,
        a: settings.action,
        m: { enabled: settings.media.enabled, onlyWhenSuspect: settings.media.onlyWhenSuspect, vision: settings.media.visionEnabled },
        s: settings.scope,
        w: settings.whitelist,
        tr: settings.triage,
        f: settings.farm,
        b: {
          jevMin: settings.budget.maxJevPerMinute,
          jevDay: settings.budget.maxJevPerDay,
          mediaMin: settings.budget.maxMediaPerMinute,
        },
      }),
    );
  }

  function cacheKey(tweet, settings) {
    const base = tweet?.id ? `id:${tweet.id}` : `h:${hash32(`${tweet?.handle}|${tweet?.text}`)}`;
    return `${base}:${hash32(tweet?.text ?? '')}:${fingerprint(settings)}`;
  }

  function readCache(key, settings, nowMs) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (nowMs - hit.ts > settings.budget.cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return hit.decision;
  }

  function writeCache(key, decision, settings, nowMs) {
    cache.set(key, { ts: nowMs, decision });
    while (cache.size > settings.budget.cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function budgetSnapshot(settings, nowMs) {
    rollDay(nowMs);
    return {
      jevMinuteRemaining: settings.budget.maxJevPerMinute - jevMinute.count(nowMs),
      jevDayRemaining: settings.budget.maxJevPerDay - day.jev,
      mediaRemaining: settings.budget.maxMediaPerMinute - mediaMinute.count(nowMs),
      triageMinuteRemaining: settings.triage.maxPerMinute - triageMinute.count(nowMs),
      triageDayRemaining: settings.triage.maxPerDay - day.triage,
      actionRemaining: Math.min(
        settings.action.maxActionsPerHour - actionHour.count(nowMs),
        settings.action.maxActionsPerDay - day.actions,
      ),
    };
  }

  async function collectMediaSignals(tweet, settings, pre) {
    const urls = (tweet?.media ?? []).slice(0, settings.media.maxImagesPerTweet);
    const out = { mediaSuspicious: false, mediaBlocked: false, mediaSkinRatio: null, mediaReasons: [], mediaResults: [] };
    if (!settings.media.enabled || urls.length === 0) return out;
    const isSuspectShape = !settings.media.onlyWhenSuspect || pre.candidate || pre.shortWithMedia;
    if (!isSuspectShape) return out;

    let best = null;
    for (const url of urls) {
      const nowMs = now();
      if (mediaMinute.count(nowMs) >= settings.budget.maxMediaPerMinute) {
        out.mediaReasons.push('media_budget_exhausted');
        break;
      }
      if (!mediaMinute.tryTake(nowMs, settings.budget.maxMediaPerMinute)) break;
      if (!analyzeImage) break;
      stats.mediaAnalyzed += 1;
      const result = await analyzeImage(url);
      out.mediaResults.push({ url, ok: Boolean(result?.ok), error: result?.error ?? null, skinRatio: result?.stats?.skinRatio ?? null });
      if (!result?.ok) continue;
      const suspicion = mediaSuspicion(result.stats, settings);
      if (!best || result.stats.skinRatio > best.stats.skinRatio) best = { stats: result.stats, suspicion, url };
      if (suspicion.blocked) break;
    }
    if (best) {
      out.mediaSuspicious = best.suspicion.suspicious;
      out.mediaBlocked = best.suspicion.blocked;
      out.mediaSkinRatio = best.stats.skinRatio;
      out.mediaReasons = best.suspicion.reasons;
    }
    return out;
  }

  async function maybeVision(tweet, settings) {
    if (!settings.media.visionEnabled || !classifyWithVision) return null;
    const url = (tweet?.media ?? [])[0];
    if (!url) return null;
    stats.visionCalls += 1;
    const result = await classifyWithVision(url, settings.media);
    if (!result?.ok) return { error: result?.error ?? 'unknown' };
    return result;
  }

  async function runDecide(tweet) {
    const started = now();
    const settings = getSettings();
    stats.decisions += 1;
    stats.lastDecisionAt = started;

    const finish = (decision) => {
      const out = {
        ...decision,
        reasonLabels: describeReasons(decision.reasons ?? []),
        category: decision.detail?.category ?? null,
        categoryLabel: decision.detail?.categoryLabel ?? null,
        tweetId: tweet?.id ?? null,
        handle: tweet?.handle ?? null,
        latencyMs: now() - started,
      };
      writeCache(cacheKey(tweet, settings), out, settings, now());
      stats.bands[out.band] = (stats.bands[out.band] ?? 0) + 1;
      const cat = out.detail?.category ?? 'unknown';
      stats.categories[cat] = (stats.categories[cat] ?? 0) + 1;
      stats.totalLatencyMs += out.latencyMs;
      return out;
    };

    if (!settings.enabled) {
      return finish({ band: BAND.ignore, reasons: [], source: 'disabled', skip: 'disabled', detail: {}, accountAction: null });
    }

    const pre = preScreen(tweet, settings);
    stats.prefilters += 1;
    if (pre.skip) {
      stats.skips += 1;
      return finish({ band: BAND.ignore, reasons: [], source: 'local', skip: pre.skip, detail: { prefilterScore: pre.score }, accountAction: null });
    }

    // 文案农场：同一段无实质内容的话被多个账号短时间复制（真站：回复区里 4 个账号刷同一句）
    const farmConfig = `${settings.farm.windowMs}:${settings.farm.minAccounts}:${settings.farm.enabled}`;
    if (farmConfig !== farmConfigKey) {
      farmTracker.configure?.(settings.farm);
      farmConfigKey = farmConfig;
    }
    const farm = settings.farm.enabled && settings.categories.farm?.enabled !== false
      ? farmTracker.record(tweet?.text, tweet?.handle)
      : { hit: false, key: null, accounts: 0 };
    if (farm.hit) stats.farmHits += 1;

    const media = await collectMediaSignals(tweet, settings, pre);
    const vision = await maybeVision(tweet, settings);

    const signals = {
      prefilterScore: pre.score,
      prefilterReasons: pre.reasons,
      shortWithMedia: pre.shortWithMedia,
      farmHit: farm.hit,
      farmAccounts: farm.accounts,
      strongNameHit: pre.strongNameHit,
      nameReasons: pre.nameReasons,
      mediaSuspicious: media.mediaSuspicious,
      mediaBlocked: media.mediaBlocked,
      mediaSkinRatio: media.mediaSkinRatio,
      visionAdultProb: vision?.ok ? vision.adultProb : null,
      visionConfidence: vision?.ok ? vision.confidence : null,
    };

    const budget = budgetSnapshot(settings, now());
    const shouldAskModel = pre.candidate || media.mediaSuspicious || vision?.ok === true;
    const stateTweet = {
      ...tweet,
      mediaSkinRatio: media.mediaSkinRatio ?? tweet.mediaSkinRatio,
      visionAdultProb: signals.visionAdultProb ?? undefined,
    };
    let answers = ZERO_ANSWERS;
    let source = 'local';
    let degraded = null;
    let junkProbability = null;
    const triage = { probed: false, escalated: false, skipped: null, junk: null };

    if (shouldAskModel && jev) {
      if (budget.jevMinuteRemaining <= 0 || budget.jevDayRemaining <= 0) {
        degraded = 'budget_exhausted';
        source = 'local';
      } else {
        jevMinute.tryTake(now(), settings.budget.maxJevPerMinute);
        day.jev += 1;
        stats.jevCalls += 1;
        try {
          const result = await jev.systemOne(buildRequest(stateTweet));
          answers = readAnswers(result?.answers);
          const expected = ['adult', 'solicitation', 'category', 'severity'];
          const missing = expected.filter((id) => !result?.answers?.[id]);
          if (missing.length > 0) {
            stats.schemaInvalid += 1;
            degraded = 'schema_invalid';
            source = 'local';
            answers = ZERO_ANSWERS;
          } else {
            source = 'jev';
          }
        } catch (error) {
          stats.jevErrors += 1;
          stats.lastError = String(error?.message ?? error);
          degraded = 'model_error';
          source = 'local';
          answers = ZERO_ANSWERS;
        }
      }
    } else if (shouldAskModel && !jev) {
      degraded = 'model_error';
    } else if (!shouldAskModel && jev && settings.triage.enabled) {
      // ---- 二级：预检（模型先行）----
      // 关键词表永远只是「廉价的怀疑」，不是召回上限：没被预筛命中的推文也要让模型看一眼，
      // 代价是一句廉价的单问；命中则升级为完整四问，未达升级线但超过隐藏线则只隐藏成待确认。
      const before = budgetSnapshot(settings, now());
      // 农场命中必须让模型看一眼（它是 hide 档判定所需的诱饵信号），所以农场命中不受采样率限制。
      if (!farm.hit && random() >= settings.triage.sampleRate) {
        triage.skipped = 'not_sampled';
      } else if (before.triageMinuteRemaining <= 0 || before.triageDayRemaining <= 0 || before.jevDayRemaining <= 0) {
        triage.skipped = 'triage_budget_exhausted';
      } else {
        triageMinute.tryTake(now(), settings.triage.maxPerMinute);
        day.triage += 1;
        day.jev += 1;
        stats.jevCalls += 1;
        stats.triageProbes += 1;
        triage.probed = true;
        try {
          const probe = await jev.systemOne({ state: buildState(stateTweet), questions: buildJunkProbe() });
          junkProbability = readJunkAnswer(probe?.answers);
          triage.junk = junkProbability;
          if (junkProbability === null) {
            stats.schemaInvalid += 1;
            triage.skipped = 'probe_answer_invalid';
          } else {
            source = 'triage';
            if (junkProbability >= settings.thresholds.junkReview) stats.triageHits += 1;
            const after = budgetSnapshot(settings, now());
            if (
              junkProbability >= settings.thresholds.junkEscalate &&
              after.jevMinuteRemaining > 0 &&
              after.jevDayRemaining > 0
            ) {
              jevMinute.tryTake(now(), settings.budget.maxJevPerMinute);
              day.jev += 1;
              stats.jevCalls += 1;
              stats.triageEscalated += 1;
              triage.escalated = true;
              const full = await jev.systemOne(buildRequest(stateTweet));
              const expected = ['adult', 'solicitation', 'category', 'severity'];
              if (expected.some((id) => !full?.answers?.[id])) {
                stats.schemaInvalid += 1;
                degraded = 'schema_invalid';
                answers = ZERO_ANSWERS;
              } else {
                answers = readAnswers(full?.answers);
                source = 'jev';
              }
            }
          }
        } catch (error) {
          stats.jevErrors += 1;
          stats.lastError = String(error?.message ?? error);
          degraded = 'model_error';
          triage.skipped = 'probe_failed';
        }
      }
    }

    const gated = gateDecide(
      answers,
      { ...signals, junkProbability, degraded, triageProbed: triage.probed },
      settings,
    );
    const action = planAccountAction({
      band: gated.band,
      settings,
      budgetRemaining: budget.actionRemaining,
      handle: tweet?.handle ?? '',
    });

    // 只有「真的会执行」的动作才消耗动作预算；演练模式不占额度。
    if (action.kind !== 'none' && action.execute) {
      actionHour.tryTake(now(), settings.action.maxActionsPerHour);
      day.actions += 1;
    }

    const reasons = [...gated.reasons];
    if (degraded) reasons.push(degraded);
    if (media.mediaSuspicious && !gated.reasons.includes('media_skin_dominated')) reasons.push(...media.mediaReasons);

    const decision = finish({
      band: gated.band,
      reasons: [...new Set(reasons)],
      source,
      skip: null,
      detail: {
        ...gated.detail,
        media: media.mediaResults,
        vision: vision ?? null,
        degraded,
        triage,
        junkProbability,
        farm: { hit: farm.hit, accounts: farm.accounts, key: farm.key },
      },
      farm: farm.hit ? { hit: true, key: farm.key, accounts: farm.accounts } : null,
      accountAction: action,
      prefilter: {
        score: pre.score,
        reasons: pre.reasons,
        newsContext: pre.newsContext,
        nameReasons: pre.nameReasons,
        strongNameHit: pre.strongNameHit,
        randomName: pre.randomName,
      },
      hideByScope: true,
    });

    if (auditor) {
      auditor
        .emit({
          type: 'decision',
          tweet: {
            id: tweet?.id ?? null,
            handle: tweet?.handle ?? null,
            context: tweet?.context ?? null,
            textPreview: String(tweet?.text ?? '').slice(0, 160),
          },
          decision: {
            band: decision.band,
            category: decision.category,
            reasons: decision.reasons,
            source: decision.source,
            detail: decision.detail,
          },
          accountAction: decision.accountAction,
        })
        .catch(() => {});
    }

    // 只要判定到 block 档就把账号记进黑名单（演练模式下也记，方便事后核对与导出），
    // 但「真的执行动作」仍然只由 accountAction.execute 决定。
    if (onActionCandidate && decision.band === BAND.block) {
      try {
        onActionCandidate(decision);
      } catch {
        /* 回调只做观测/通知 */
      }
    }

    return decision;
  }

  return {
    /** 同一条推文并发只判一次；结果按 id+文案+阈值指纹缓存。 */
    async decide(tweet) {
      const settings = getSettings();
      const key = cacheKey(tweet, settings);
      const nowMs = now();
      const cached = readCache(key, settings, nowMs);
      if (cached) {
        stats.cacheHits += 1;
        return { ...cached, source: 'cache', cached: true, latencyMs: 0 };
      }
      if (inflight.has(key)) return inflight.get(key);
      const promise = runDecide(tweet).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    stats() {
      return { ...stats, bands: { ...stats.bands }, categories: { ...stats.categories }, cacheSize: cache.size, inflight: inflight.size };
    },
    clearCache() {
      cache.clear();
    },
    budget() {
      return budgetSnapshot(getSettings(), now());
    },
  };
}
