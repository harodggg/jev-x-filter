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
import { createFarmTracker, hasRepeatedLine } from './farm.js';
import { planEmotionFold } from './lowSignal.js';
import { mediaSuspicion } from './media.js';
import { preScreen } from './prefilter.js';
import { createRecentWindow, planSemanticCall, readSemanticsAnswers } from './semantics.js';
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
    /** 所有 Jev 调用（过滤 + 预检 + 语义整理）：与 day.jev / 全局预算口径一致。 */
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
    /**
     * α / β 语义层（只影响展示载荷，不影响 band / accountAction）。
     * - calls：实际发出的语义调用次数；candidateSets：其中带候选组的次数；
     * - betaFolds / alphaHits：折叠与标记次数；skipped：预算耗尽等「本该调用但跳过」；
     * - errors：语义调用抛错次数（过滤结果照常返回）。
     */
    semantics: { calls: 0, betaFolds: 0, alphaHits: 0, skipped: 0, errors: 0, candidateSets: 0 },
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
    /** 运行态持久化（Service Worker 空闲回收后恢复农场簇与调用/动作预算）。 */
    runtime = null,
  } = deps;

  const cache = new Map();
  let runtimeReady = null;
  let saveTimer = null;

  function scheduleRuntimeSave() {
    if (!runtime?.save) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void runtime.save(snapshotRuntime()).catch(() => {});
    }, 500);
  }

  function snapshotRuntime() {
    return {
      farm: farmTracker.serialize(),
      budget: {
        // 只带「每天计数」与「每小时动作窗口」：它们跨重启必须保留（否则限速被绕过、
        // 每日额度被重置）。分钟级窗口不带 —— 重启后重置它们不会放宽任何安全约束，
        // 反而会把「上一分钟的调用」算进新会话，导致刚启动就超预算（端到端场景 D 踩到过）。
        day,
        actionHour: actionHour.stamps,
      },
    };
  }

  function restoreRuntime(data) {
    if (!data) return;
    try {
      farmTracker.restore(data.farm);
    } catch {
      /* 数据结构变了就当没有 */
    }
    if (data.budget?.day && typeof data.budget.day.key === 'string') day = { ...day, ...data.budget.day };
    for (const [window, stamps] of [[actionHour, data.budget?.actionHour]]) {
      if (Array.isArray(stamps)) window.stamps = stamps.filter((t) => Number.isFinite(t));
    }
  }

  function ensureRuntimeLoaded() {
    if (!runtimeReady) {
      runtimeReady = (async () => {
        if (!runtime?.load) return;
        try {
          restoreRuntime(await runtime.load());
        } catch {
          /* 读不回来就按空状态跑 */
        }
      })();
    }
    return runtimeReady;
  }

  void ensureRuntimeLoaded();
  /** 最近判定（调试/端到端诊断用；只读，不进审计）。 */
  const recent = [];
  /** 最近收到的推文输入（排障用：内容脚本到底抽到了什么 context / threadId / 文本）。 */
  const recentInputs = [];
  /**
   * β 的本地分支：**情绪言论**（愤怒 / 喜悦 / 支持 / 反对 / 悲伤 / 确认 / 表情）的折叠计划。
   * 0 次模型调用；纯展示，绝不参与 band / accountAction（不变量 I1）。
   * 只对回复区生效（按键 threadId 归组），并尊重用户开关与折叠/隐藏模式。
   */
  function planLocalFold(tweet, observed, settings) {
    const sem = settings.semantics;
    if (!sem?.enabled) return null;
    if (sem.emotion && sem.emotion.enabled === false) return null;
    // 兼容 v0.4.2 的旧开关（foldLowSignal）；新键是 semantics.emotion.*
    if (!sem.emotion && sem.beta?.foldLowSignal === false) return null;
    // 回复区看 foldInReplies，时间线/推荐流看 foldInFeed（与模型版 β 的开关语义一致）。
    const isReply = tweet?.context === 'reply';
    if (isReply && sem.beta?.foldInReplies === false) return null;
    if (!isReply && sem.beta?.foldInFeed === false) return null;
    const mode = sem.emotion?.mode === 'hide' ? 'hide' : 'fold';
    return planEmotionFold(observed ?? tweet, semanticRecent.list(), { mode, scope: isReply ? 'thread' : 'feed' });
  }

  const farmTracker = createFarmTracker();
  let farmConfigKey = '';
  const inflight = new Map();
  const stats = emptyStats();
  const jevMinute = new RateWindow(60000);
  const triageMinute = new RateWindow(60000);
  const mediaMinute = new RateWindow(60000);
  const semanticsMinute = new RateWindow(60000);
  const actionHour = new RateWindow(3600000);
  /** 最近推文窗口：α/β 的候选与参考都从这里来（不是判定缓存）。 */
  const semanticRecent = createRecentWindow({ maxSize: 60, now });
  let day = { key: dayKey(now()), jev: 0, actions: 0, triage: 0, semantics: 0 };

  function rollDay(nowMs) {
    const key = dayKey(nowMs);
    if (key !== day.key) day = { key, jev: 0, actions: 0, triage: 0, semantics: 0 };
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
        sem: settings.semantics,
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
      semanticsMinuteRemaining: (settings.semantics?.maxPerMinute ?? 0) - semanticsMinute.count(nowMs),
      semanticsDayRemaining: (settings.semantics?.maxPerDay ?? 0) - day.semantics,
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

  /**
   * α / β 语义层：在**过滤判定完成之后**附加，永远不参与 band / accountAction 的计算（I1）。
   *
   * 一轮最多一次调用：本地先筛候选（0 候选 / 场景开关关掉 / 预算不允许都不发请求）。
   * 任何失败都只记 `stats.semantics.errors` 并把 beta/alpha 留成 null —— 决策照常返回，
   * 不允许把过滤结果带崩，也不允许把异常抛给调用方。
   */
  async function runSemanticsLayer(tweet, settings, observed = null) {
    const semStats = stats.semantics;
    const detail = { status: 'skipped', reason: null, candidates: 0, references: 0 };
    const out = { beta: null, alpha: null, detail };
    const sem = settings.semantics;
    // 用窗口条目当 target：它带 band / farmKey / seq（同农场簇候选与「只折叠到更早的推文」都要用）。
    const target = observed ?? tweet;
    if (!sem?.enabled) {
      detail.reason = 'semantics_disabled';
      return out;
    }
    if (!jev) {
      // 没有可用客户端：这是「本该判定但跳过」，计入 skipped（与预算耗尽同类）。
      detail.reason = 'no_client';
      semStats.skipped += 1;
      return out;
    }

    semanticRecent.configure({ maxSize: sem.beta?.windowSize });
    const plan = planSemanticCall({
      target,
      recent: semanticRecent.list(),
      settings,
      selfSeq: observed?.seq ?? Number.POSITIVE_INFINITY,
    });
    detail.candidates = plan.candidateCount;
    detail.references = plan.referenceCount;
    if (!plan.call) {
      // 0 候选 / 开关关闭：正常跳过，不占预算也不算「超预算跳过」（UI 的 skipped 标签是「超预算」）。
      detail.reason = plan.reason ?? 'no_candidates';
      return out;
    }

    rollDay(now());
    const minuteRemaining = (sem.maxPerMinute ?? 0) - semanticsMinute.count(now());
    const dayRemaining = (sem.maxPerDay ?? 0) - day.semantics;
    // 语义调用同样计入**全局 Jev 预算**（否则总花费会突破用户设的上限），
    // 并且必须给过滤留出保底额度：全局剩余 ≤ reserveForFiltering 时语义层不再调用，
    // 保证「类判定 / 预检」永远有额度可用（语义整理只是锦上添花）。
    const jevMinuteRemaining = settings.budget.maxJevPerMinute - jevMinute.count(now());
    const jevDayRemaining = settings.budget.maxJevPerDay - day.jev;
    const reserve = sem.reserveForFiltering ?? 0;
    if (minuteRemaining <= 0 || dayRemaining <= 0 || jevMinuteRemaining <= 0 || jevDayRemaining <= reserve) {
      detail.reason = 'budget_exhausted';
      semStats.skipped += 1;
      return out;
    }

    semanticsMinute.tryTake(now(), sem.maxPerMinute);
    jevMinute.tryTake(now(), settings.budget.maxJevPerMinute);
    day.semantics += 1;
    day.jev += 1;
    // 语义调用也要计入「模型调用」总数（弹窗/设置页读的是 jevCalls）：
    // 否则会出现「模型调用 5 · 语义调用 3」这种自相矛盾的数字。
    stats.jevCalls += 1;
    semStats.calls += 1;
    if (plan.candidateCount > 0) semStats.candidateSets += 1;
    detail.status = 'ok';
    try {
      const result = await jev.systemOne({ state: plan.state, questions: plan.questions });
      const parsed = readSemanticsAnswers(result?.answers, { plan, target, settings });
      out.beta = parsed.beta;
      out.alpha = parsed.alpha;
      if (parsed.beta) semStats.betaFolds += 1;
      if (parsed.alpha) semStats.alphaHits += 1;
    } catch (error) {
      // 语义层失败不影响过滤结果：只计数，beta/alpha 保持 null。
      semStats.errors += 1;
      detail.status = 'error';
      detail.reason = `model_error:${String(error?.message ?? error)}`;
    }
    return out;
  }

  async function runDecide(tweet) {
    const started = now();
    const settings = getSettings();
    stats.decisions += 1;
    stats.lastDecisionAt = started;

    // 「先观察、后判定」：在任何 await 之前就把这条推文放进最近窗口。
    // 浏览器里同一屏的多篇文章是**并发**判定的（inspectArticle 并发发消息，SW 在 await 处交错），
    // 如果等模型往返之后再记录，后一条规划语义时就看不到前一条 → β/α 在真实时间线上大面积失效
    // （真实 Chrome 端到端抓到的缺陷：1102 → no_candidates）。
    // 口径：窗口是「观察到的推文」，不是「已完成判定的推文」；被 prefilter 跳过的条目也在里面
    // （它们本来就放行，band 回填为 ignore）。判定完成后回填 band/farmKey 供 α 护栏使用。
    const observed = semanticRecent.push({ ...tweet, farmKey: null });

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
      recent.push({
        id: out.tweetId,
        handle: out.handle,
        band: out.band,
        source: out.source,
        farm: out.farm ? out.farm.accounts : 0,
        reasons: out.reasons.slice(0, 3),
        // 诊断用（端到端排障时能直接看到「这条为什么没折叠」）
        skip: out.skip ?? null,
        context: tweet?.context ?? null,
        threadId: tweet?.threadId ?? null,
        betaKind: out.beta?.kind ?? null,
        betaFolded: out.beta?.folded === true,
      });
      if (recent.length > 40) recent.splice(0, recent.length - 40);
      stats.bands[out.band] = (stats.bands[out.band] ?? 0) + 1;
      const cat = out.detail?.category ?? 'unknown';
      stats.categories[cat] = (stats.categories[cat] ?? 0) + 1;
      stats.totalLatencyMs += out.latencyMs;
      return out;
    };

    if (!settings.enabled) {
      if (observed) observed.band = BAND.ignore;
      return finish({
        band: BAND.ignore,
        reasons: [],
        source: 'disabled',
        skip: 'disabled',
        // 冻结接口：语义层未运行也保持 beta/alpha = null，消费方不用区分 undefined。
        beta: null,
        alpha: null,
        detail: { semantics: { status: 'skipped', reason: 'semantics_disabled', candidates: 0, references: 0 } },
        accountAction: null,
      });
    }

    const pre = preScreen(tweet, settings);
    stats.prefilters += 1;
    if (pre.skip) {
      stats.skips += 1;
      if (observed) observed.band = BAND.ignore;
      // 「认同 / 确定 / 哈哈哈」这类附和大多只有 2–4 个字，正好会被「过短无媒体」跳过；
      // 跳过的是**判定**（不隐藏、不动作、不花调用），但展示层的 β 折叠仍然要给 —— 否则
      // 「同一线程只留一条附和」永远不生效。只对 too_short_no_media 这么做：
      // 白名单 / 自己发的 / scope 关掉这些显式选择必须连折叠一起尊重。
      const skipBeta = pre.skip === 'too_short_no_media' ? planLocalFold(tweet, observed, settings) : null;
      if (skipBeta) stats.semantics.betaFolds += 1;
      return finish({
        band: BAND.ignore,
        reasons: [],
        source: 'local',
        skip: pre.skip,
        beta: skipBeta,
        alpha: null,
        detail: {
          prefilterScore: pre.score,
          semantics: { status: 'skipped', reason: 'prefilter_skipped', candidates: 0, references: 0 },
        },
        accountAction: null,
      });
    }

    // 文案农场：同一段无实质内容的话被多个账号短时间复制（真站：回复区里 4 个账号刷同一句）
    const farmConfig = `${settings.farm.windowMs}:${settings.farm.minAccounts}:${settings.farm.minSimilarity}:${settings.farm.enabled}`;
    if (farmConfig !== farmConfigKey) {
      farmTracker.configure?.(settings.farm);
      farmConfigKey = farmConfig;
    }
    const farm = settings.farm.enabled && settings.categories.farm?.enabled !== false
      ? farmTracker.record(tweet?.text, tweet?.handle)
      : { hit: false, key: null, accounts: 0, samples: [] };
    // 同一条推文里重复同一句话（Shantel Just 那种「同一句写两遍」）也是刷屏特征
    const repeatInPost = settings.categories.farm?.enabled !== false && hasRepeatedLine(tweet?.text);
    if (farm.hit) stats.farmHits += 1;
    // 农场簇键在语义规划（过滤判定之后）之前回填：`pickBetaCandidates` 的「同农场簇」候选要用它。
    if (observed) observed.farmKey = farm.key ?? null;
    scheduleRuntimeSave();
    if (repeatInPost && !farm.hit) stats.repeatInPost = (stats.repeatInPost ?? 0) + 1;

    const media = await collectMediaSignals(tweet, settings, pre);
    const vision = await maybeVision(tweet, settings);

    const signals = {
      prefilterScore: pre.score,
      prefilterReasons: pre.reasons,
      shortWithMedia: pre.shortWithMedia,
      farmHit: farm.hit,
      farmAccounts: farm.accounts,
      repeatInPost,
      strongNameHit: pre.strongNameHit,
      reviewFloor: pre.reviewFloor === true,
      // X 自己标的「可能的垃圾信息」分区（内容脚本读标题得到）——只给隐藏成待确认的下限
      xSpamSection: pre.xSpamSection === true,
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
      if (!farm.hit && !repeatInPost && random() >= settings.triage.sampleRate) {
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
      scheduleRuntimeSave();
    }

    // α/β 语义层：在过滤判定**完成之后**附加，只做展示载荷，绝不参与 band / 动作（I1）。
    // 窗口读取发生在判定之后，但入窗在 runDecide 最前面（并发下的可见性靠这个）。
    const semantics = await runSemanticsLayer(tweet, settings, observed);
    // β 的**本地**分支：情绪 / 认同 / 确认 这类「没有实质内容的附和」彼此字符串不同，
    // 3-gram 相似度与文案农场都抓不到，但它们语义上是同一类东西 —— 同一线程里只留最早的一条。
    // 0 次模型调用；模型已经给出 β 折叠时以模型为准；α 命中时不折叠（沿用既有优先级）。
    const lowSignalBeta =
      !semantics.beta && !semantics.alpha?.hit ? planLocalFold(tweet, observed, settings) : null;
    // 低信息量附和也是 β 折叠的一种（同一栏「β 折叠数」里计数，不新增统计字段）。
    if (lowSignalBeta) stats.semantics.betaFolds += 1;

    const reasons = [...gated.reasons];
    if (degraded) reasons.push(degraded);
    if (media.mediaSuspicious && !gated.reasons.includes('media_skin_dominated')) reasons.push(...media.mediaReasons);

    const decision = finish({
      band: gated.band,
      reasons: [...new Set(reasons)],
      source,
      skip: null,
      // 冻结接口：不适用时为 null；它们只影响展示（折叠 / 标记），不改 band 与 accountAction。
      beta: semantics.beta ?? lowSignalBeta,
      alpha: semantics.alpha,
      detail: {
        ...gated.detail,
        media: media.mediaResults,
        vision: vision ?? null,
        degraded,
        triage,
        junkProbability,
        semantics: { ...semantics.detail, local: lowSignalBeta ? { kind: lowSignalBeta.kind, emotion: lowSignalBeta.emotion, emotionLabel: lowSignalBeta.emotionLabel, mode: lowSignalBeta.mode, representative: lowSignalBeta.representative, groupSize: lowSignalBeta.groupSize } : null },
        farm: { hit: farm.hit, accounts: farm.accounts, key: farm.key, similarity: farm.similarity, repeatInPost },
      },
      farm: farm.hit
        ? { hit: true, key: farm.key, accounts: farm.accounts, similarity: farm.similarity, samples: farm.samples }
        : null,
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

    // 判定完成 → 回填窗口条目的 band：α 的参考集合据此排除 hide / block / review
    // （已隐藏的垃圾评论不该被当成「评论区多数观点」）。
    if (observed) observed.band = decision.band;

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
      await ensureRuntimeLoaded();
      recentInputs.push({
        id: tweet?.id ?? null,
        handle: tweet?.handle ?? null,
        context: tweet?.context ?? null,
        threadId: tweet?.threadId ?? null,
        text: String(tweet?.text ?? '').slice(0, 40),
      });
      if (recentInputs.length > 40) recentInputs.splice(0, recentInputs.length - 40);
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
      return {
        ...stats,
        bands: { ...stats.bands },
        categories: { ...stats.categories },
        semantics: { ...stats.semantics },
        cacheSize: cache.size,
        inflight: inflight.size,
      };
    },
    clearCache() {
      cache.clear();
    },
    /** 最近 40 条判定（诊断用）。 */
    recent() {
      return recent.slice();
    },
    recentInputs() {
      return recentInputs.slice();
    },
    /** 运行态快照（持久化/诊断用）。 */
    snapshotRuntime,
    budget() {
      return budgetSnapshot(getSettings(), now());
    },
  };
}
