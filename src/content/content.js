/**
 * 内容脚本：只做 DOM 与「执行动作」，不做判定。
 *
 * 流程：MutationObserver 发现推文 → 归一化 → 交给 Service Worker 判定（Jev）→
 *       按判定隐藏/折叠，必要时点击菜单静音/拉黑（受演练模式与预算约束）。
 *
 * 所有推文文本都通过 textContent 写入 DOM（绝不拼 innerHTML），避免把推文里的
 * HTML 注入到页面；页面上的一切判断都来自扩展自身的白名单字段。
 */
(function initContent() {
  'use strict';

  const S = globalThis.JevXSelectors;
  const X = globalThis.JevXExtract;
  const VERSION = '0.4.8';

  const state = {
    settings: null,
    enabled: false,
    /** 设置变更时 +1，让所有推文重新判定（内容签名 + epoch 决定是否需要重跑）。 */
    epoch: 1,
    decisions: new Map(),
    hidden: new Map(),
    actions: 0,
    planned: 0,
    errors: 0,
    lastActionAt: 0,
    /** 最近一次账号动作失败的原因与当时的菜单内容（供设置页/端到端诊断选择器漂移）。 */
    lastActionError: null,
    /** 最近一次内容脚本异常（真站排障用；不算判定失败，只说明某条 DOM 出乎意料）。 */
    lastError: null,
    /** 失败**历史**（最多 10 条）：一次失败之后如果还有别的推文动作成功，只留 lastActionError 就会被清掉，
     *  真站排障时「为什么这条没静音」需要的是历史而不是最后一刻的状态。 */
    actionErrors: [],
    ownHandle: '',
    startedAt: Date.now(),
  };

  let observer = null;
  let intersectionObserver = null;
  let scanTimer = null;
  /**
   * 同一账号在同一页面只执行一次同类动作（静音/拉黑）。
   * DOM 复渲染、重复扫描、页面内多次命中都不应该把账号动作做两遍。
   */
  const acted = new Set();
  /**
   * 文案农场索引：归一化文案 → 该文案在页面上的所有 article。
   * 农场是「第 3 个账号出现时才成立」的判定，所以命中的那一刻要把同文案的**前两条**也补上隐藏
   * （它们当时的判定是 ignore，缓存里不会自己变）。这一步只改展示，不做任何账号动作。
   */
  const farmIndex = new Map();
  /** 近似判定的相似度阈值（与 SW 侧 settings.farm.minSimilarity 默认值一致）。 */
  const FARM_SIMILARITY = 0.8;
  /**
   * 菜单自动化必须串行：菜单是「整个页面共用」的浮层，
   * 两条推文同时点开会互相抢菜单（第二条会点到第一条的菜单项）。
   */
  let actionQueue = Promise.resolve();

  function enqueueAction(task) {
    actionQueue = actionQueue.then(task, task);
    return actionQueue;
  }

  function debugEnabled() {
    return Boolean(state.settings?.ui?.debug) || globalThis.__jevxDebug === true;
  }

  function log(...args) {
    if (debugEnabled()) console.debug('[黄推过滤器]', ...args);
  }

  /** 与 SW 通信：上下文失效（扩展被重载）时不抛异常，只静默失败。 */
  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
          resolve({ ok: false, error: 'context_invalidated' });
          return;
        }
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response ?? { ok: false, error: 'no_response' });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) });
      }
    });
  }

  function audit(event, tweet, extra = {}) {
    void send('JEVX_AUDIT_EVENT', {
      event: {
        type: event,
        page: { url: location.href, title: document.title },
        tweet: tweet
          ? {
              id: tweet.id,
              handle: tweet.handle,
              context: tweet.context,
              textPreview: String(tweet.text ?? '').slice(0, 160),
            }
          : null,
        ...extra,
      },
    });
  }

  /* ------------------------------- 渲染判定条 ------------------------------- */

  function buildBar(tweet, decision) {
    const bar = document.createElement('div');
    bar.className = `jevx-bar${decision.band === 'review' ? ' jevx-review' : ''}`;

    const tag = document.createElement('span');
    tag.className = 'jevx-tag';
    const label = decision.categoryLabel || '';
    tag.textContent =
      decision.band === 'block'
        ? `已过滤${label ? `（${label}）` : '（高置信度）'}`
        : decision.band === 'review'
          ? `疑似垃圾信息${label ? `（${label}）` : ''} · 待确认`
          : `已过滤${label ? `（${label}）` : ''}`;
    bar.appendChild(tag);

    const score = document.createElement('span');
    score.className = 'jevx-score';
    const detail = decision.detail ?? {};
    const parts = [];
    if (typeof detail.adult === 'number') parts.push(`色情概率 ${(detail.adult * 100).toFixed(0)}%`);
    if (detail.deceptive > 0.5) parts.push(`欺骗概率 ${(detail.deceptive * 100).toFixed(0)}%`);
    if (typeof detail.categoryConfidence === 'number' && detail.categoryConfidence > 0) {
      parts.push(`类别置信度 ${(detail.categoryConfidence * 100).toFixed(0)}%`);
    }
    if (detail.mediaSkinRatio !== null && detail.mediaSkinRatio !== undefined) {
      parts.push(`图片肤色占比 ${(detail.mediaSkinRatio * 100).toFixed(0)}%`);
    }
    if (decision.prefilter?.score) parts.push(`本地特征分 ${decision.prefilter.score}`);
    score.textContent = parts.join(' · ');
    bar.appendChild(score);

    const reason = document.createElement('span');
    reason.className = 'jevx-reason';
    const labels = decision.reasonLabels?.length ? decision.reasonLabels : decision.reasons ?? [];
    reason.textContent = `@${tweet.handle ?? '?'} · ${labels.join('，') || '命中过滤规则'}${decision.source === 'cache' ? '（缓存）' : ''}`;
    reason.title = labels.join('，');
    bar.appendChild(reason);

    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.textContent = '显示';
    showBtn.addEventListener('click', () => showTweet(tweet));
    bar.appendChild(showBtn);

    const fpBtn = document.createElement('button');
    fpBtn.type = 'button';
    fpBtn.textContent = '误判（加入白名单）';
    fpBtn.addEventListener('click', () => markFalsePositive(tweet, decision));
    bar.appendChild(fpBtn);

    if (state.settings?.action?.autoMute || state.settings?.action?.autoBlock) {
      const actBtn = document.createElement('button');
      actBtn.type = 'button';
      actBtn.className = 'jevx-danger';
      actBtn.textContent = state.settings.action.autoBlock ? '立即拉黑' : '立即静音';
      actBtn.addEventListener('click', async () => {
        actBtn.disabled = true;
        actBtn.textContent = '处理中…';
        const ok = await enqueueAction(() =>
          performAccountAction(
            findArticleByKey(tweet),
            tweet,
            {
              accountAction: {
                kind: state.settings.action.autoBlock ? (state.settings.action.autoMute ? 'both' : 'block') : 'mute',
                execute: true,
                dryRun: false,
                reason: 'manual',
              },
            },
            { force: true },
          ),
        );
        actBtn.textContent = ok ? '已执行' : '失败';
        audit(ok ? 'action' : 'action_failed', tweet, { accountAction: { kind: actBtn.textContent, manual: true } });
      });
      bar.appendChild(actBtn);
    }

    if (decision.accountAction && !decision.accountAction.execute && decision.accountAction.kind !== 'none') {
      const note = document.createElement('span');
      note.className = 'jevx-score';
      note.textContent =
        decision.accountAction.reason === 'dry_run'
          ? `演练模式：本应${decision.accountAction.kind === 'mute' ? '静音' : '拉黑'}该账号`
          : decision.accountAction.reason === 'farm_retro'
            ? '同文案刷屏，已一并隐藏'
            : `未执行账号动作（${decision.accountAction.reason}）`;
      bar.appendChild(note);
    }

    return bar;
  }

  function findArticleByKey(tweet) {
    const key = X.tweetKey(tweet);
    for (const article of S.findTweets(document)) {
      if (state.hidden.get(key)?.article === article) return article;
      const other = X.parseTweet(article);
      if (X.tweetKey(other) === key) return article;
    }
    return null;
  }

  /* ----------------------- β 折叠条 / α 徽标（纯展示） ----------------------- */

  /**
   * 端到端测试与调试依赖的稳定属性（见 tools/verify-in-chrome.js）：
   * - article.dataset.jevxBeta = '1'         这条推文被 β 折叠（展开后仍保留，表示「这条是相似内容」）
   * - article.dataset.jevxBetaExpanded = '1' 折叠条当前处于展开态
   * - article.dataset.jevxAlpha = '1'        这条推文带 α 徽标
   * 三个属性都只是展示层状态，**不参与**隐藏判定与账号动作。
   */

  /** 按推文 id 找页面上的 article：用来把 beta.duplicateOf（推文 id）显示成 @handle。 */
  function findArticleById(id) {
    const wanted = String(id ?? '');
    if (!wanted) return null;
    for (const article of S.findTweets(document)) {
      if (String(S.getTweetId(article) ?? '') === wanted) return article;
      if (String(article.dataset.jevxId ?? '') === wanted) return article;
    }
    return null;
  }

  /** β 条里代表账号的显示名：优先 SW 直接给的 handle，否则在当前页面按推文 id 反查。 */
  function resolveDuplicateLabel(beta) {
    const explicit = beta?.duplicateOfHandle ?? beta?.handle;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().replace(/^@/, '');
    if (!beta?.duplicateOf) return '';
    const found = findArticleById(beta.duplicateOf);
    return found ? S.getHandle(found) || '' : '';
  }

  function buildBetaBar(article, tweet, beta) {
    const bar = document.createElement('div');
    bar.className = 'jevx-beta-bar';
    bar.setAttribute('role', 'note');

    const label = resolveDuplicateLabel(beta);
    // 低信息量附和（愤怒 / 喜悦 / 支持 / 反对 / 赞美 / 期待 / 问候 / 社交 / 参与…）走同一套 β 折叠条，
    // 但文案要说清「属于哪一类」以及这是折叠还是隐藏 —— 这正是用户要的那份「信息」。
    const isEmotion = beta?.kind === 'emotion';
    // v0.4.7：整条线程的低信息量附和合并成一条 → 条上写清「本条类别」+「把多少条什么合并了」。
    // 例：`情绪 · 参与（低信息量附和 6 条：参与 3 · 赞美 2 · 期待 1）`
    const breakdown = String(beta?.classBreakdown ?? '').trim();
    const merged = String(beta?.merged ?? '').trim();
    const mergeSize = Number(beta?.groupSize);
    const mergeTag = merged && Number.isFinite(mergeSize) && mergeSize > 1
      ? `（${merged} ${mergeSize} 条${breakdown ? `：${breakdown}` : ''}）`
      : '';
    const emotionTag = isEmotion
      ? `情绪 · ${beta?.emotionLabel ?? '情绪'}${mergeTag}`
      : '';
    const isFeedEmotion = isEmotion && beta?.scope === 'feed';
    const isAgreement = beta?.kind === 'agreement';
    const sameText = isFeedEmotion
      ? (() => {
          const preview = String(beta?.contentPreview ?? '').trim();
          const suffix = beta?.mode === 'hide' ? '（已隐藏）' : '（已折叠）';
          return preview ? `${preview}${suffix}` : `情绪言论${suffix}`;
        })()
      : isEmotion
        ? label
          ? `与 @${label} 的低信息量附和合并显示`
          : beta?.mode === 'hide'
            ? '已隐藏（同线程低信息量附和）'
            : mergeSize > 1
              ? '本线程低信息量附和已合并显示'
              : '低信息量附和'
      : isAgreement
        ? label
          ? `与 @${label} 的同类附和（情绪/认同/确认）`
          : '与上一条同类附和（情绪/认同/确认）'
        : label
          ? `与 @${label} 的内容相同`
          : `与 @${String(beta?.duplicateOf ?? '?')} 的内容相同`;
    const groupSize = Number(beta?.groupSize);
    const others = Number.isFinite(groupSize) ? Math.max(0, groupSize - 1) : 0;
    const baseText = isEmotion
      ? others > 0
        ? `${emotionTag}：${sameText} · 还有 ${others} 条`
        : `${emotionTag}：${sameText}`
      : isAgreement
        ? `${sameText} · 还有 ${others} 条同类回复`
        : `${sameText} · 还有 ${others} 条相似内容`;

    const text = document.createElement('span');
    text.className = 'jevx-beta-text';
    text.textContent = baseText;
    const kindLabel =
      {
        verbatim: '内容完全相同',
        paraphrase: '措辞不同、意思相同',
        same_claim: '表达同一个说法',
        agreement: '低信息量附和（情绪/认同/确认）',
        emotion: isEmotion ? `情绪言论 · ${beta?.emotionLabel ?? ''}（${beta?.mode === 'hide' ? '已隐藏' : '已折叠'}）` : '',
      }[beta?.kind] ?? '相似内容';
    const detail = [kindLabel];
    if (Number.isFinite(Number(beta?.similarity))) detail.push(`相似度 ${(Number(beta.similarity) * 100).toFixed(0)}%`);
    if (beta?.groupKey) detail.push(`分组 ${beta.groupKey}`);
    text.title = detail.join(' · ');
    bar.appendChild(text);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'jevx-beta-toggle';
    toggle.textContent = '展开';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', '展开被折叠的相似内容');
    toggle.addEventListener('click', (event) => {
      // 不要冒泡给 X 的 article 点击处理，否则展开/收起会顺带打开详情页。
      event?.stopPropagation?.();
      setBetaExpanded(article, bar, text, baseText, article.dataset.jevxBetaExpanded !== '1');
    });
    bar.appendChild(toggle);
    return bar;
  }

  /**
   * 切换折叠/展开：条本身保留（再次点击才能折叠回去），只按属性让子节点重新可见。
   * 展开不触碰 state.hidden / state.decisions / 账号动作。
   */
  function setBetaExpanded(article, bar, textEl, baseText, expanded) {
    if (expanded) article.dataset.jevxBetaExpanded = '1';
    else delete article.dataset.jevxBetaExpanded;
    bar.classList.toggle('jevx-beta-bar--expanded', expanded);
    textEl.textContent = expanded ? `已展开 · ${baseText}` : baseText;
    const toggle = bar.querySelector('.jevx-beta-toggle');
    if (toggle) {
      toggle.textContent = expanded ? '收起' : '展开';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-label', expanded ? '重新折叠这条相似内容' : '展开被折叠的相似内容');
    }
  }

  function clearBeta(article) {
    if (!article) return;
    article.querySelectorAll(':scope > .jevx-beta-bar').forEach((el) => el.remove());
    delete article.dataset.jevxBeta;
    delete article.dataset.jevxBetaExpanded;
  }

  /**
   * β 折叠：仅当 SW 明确给了 `beta.folded === true`、且不是 α 命中、且这条推文没有被过滤时执行。
   * 缺字段 / folded 非 true 时走 clearBeta，行为与引入 α/β 之前完全一致。
   */
  function applyBetaFold(article, tweet, decision) {
    const beta = decision?.beta;
    const alphaHit = decision?.alpha?.hit === true;
    if (!beta || beta.folded !== true || alphaHit || article.dataset.jevxHidden === '1') {
      clearBeta(article);
      return;
    }
    if (article.dataset.jevxBeta === '1' && article.querySelector(':scope > .jevx-beta-bar')) return;
    clearBeta(article);
    article.insertBefore(buildBetaBar(article, tweet, beta), article.firstChild);
    article.dataset.jevxBeta = '1';
    delete article.dataset.jevxBetaExpanded;
    log('β 折叠', tweet.id, beta.groupKey, beta.kind);
  }

  function buildAlphaBadge(alpha) {
    const badge = document.createElement('div');
    badge.className = 'jevx-alpha-badge';
    badge.setAttribute('role', 'note');

    const summary = typeof alpha?.summary === 'string' && alpha.summary.trim() ? alpha.summary.trim() : '与评论区多数观点不同';
    const span = document.createElement('span');
    span.className = 'jevx-alpha-text';
    span.textContent = `α · ${summary}`;
    badge.appendChild(span);

    const refs = Number(alpha?.referenceCount);
    const score = Number(alpha?.score);
    const detail = [];
    if (Number.isFinite(refs)) detail.push(`参照 ${refs} 条`);
    if (Number.isFinite(score)) detail.push(`分数 ${score.toFixed(2)}`);
    badge.title = detail.length ? `${summary}（${detail.join(' · ')}）` : summary;
    badge.setAttribute('aria-label', detail.length ? `α ${summary}，${detail.join('，')}` : `α ${summary}`);
    return badge;
  }

  function clearAlpha(article) {
    if (!article) return;
    article.querySelectorAll(':scope > .jevx-alpha-badge').forEach((el) => el.remove());
    delete article.dataset.jevxAlpha;
  }

  /** 情绪徽标：fold 模式下线程里第一条同类情绪回复保留可见，用徽标标明它是哪一类情绪。 */
  function buildEmotionBadge(beta) {
    const badge = document.createElement('div');
    badge.className = 'jevx-emotion-badge';
    badge.setAttribute('role', 'note');

    const label = beta?.emotionLabel ?? '情绪';
    const span = document.createElement('span');
    span.className = 'jevx-emotion-text';
    span.textContent = `情绪 · ${label}`;
    badge.appendChild(span);

    const detail = [];
    if (Number.isFinite(Number(beta?.groupSize))) detail.push(`同线程同类 ${beta.groupSize} 条`);
    badge.title = detail.length ? `${label}（${detail.join(' · ')}）` : label;
    badge.setAttribute('aria-label', `情绪类别：${label}`);
    return badge;
  }

  function clearEmotionBadge(article) {
    if (!article) return;
    article.querySelectorAll(':scope > .jevx-emotion-badge').forEach((el) => el.remove());
    delete article.dataset.jevxEmotion;
  }

  /** 情绪标记：只加徽标（不改变隐藏/折叠与账号动作），让用户一眼看到「这是哪一类情绪」。 */
  function applyEmotionBadge(article, decision) {
    const beta = decision?.beta;
    clearEmotionBadge(article);
    if (beta?.kind !== 'emotion' || beta.folded === true) return;
    if (article.dataset.jevxHidden === '1') return;
    article.insertBefore(buildEmotionBadge(beta), article.firstChild);
    article.dataset.jevxEmotion = String(beta.emotion ?? '1');
  }

  /** α 标记：只加徽标，**不隐藏、不折叠**，也不改变任何账号动作。 */
  function applyAlphaMark(article, decision) {
    const alpha = decision?.alpha;
    if (!alpha || alpha.hit !== true || article.dataset.jevxHidden === '1') {
      clearAlpha(article);
      return;
    }
    if (article.querySelector(':scope > .jevx-alpha-badge')) return;
    article.insertBefore(buildAlphaBadge(alpha), article.firstChild);
    article.dataset.jevxAlpha = '1';
    log('α 标记', article.dataset.jevxKey, alpha.reason);
  }

  /** 记录 article 与它的农场键，供农场命中时追溯隐藏。 */
  function indexFarm(article, tweet) {
    const key = X.farmKey(tweet?.text);
    if (!key) return null;
    const list = farmIndex.get(key) ?? [];
    if (!list.includes(article)) list.push(article);
    farmIndex.set(key, list);
    return key;
  }

  /**
   * 农场命中：把**近似同文案**的其它推文也隐藏（纯展示层，不产生账号动作）。
   * 用近似比较而不是精确相等 —— 农场账号会在同一句里各插不同垃圾字符。
   */
  function retroHideFarm(samples, decision, exclude) {
    const list = Array.isArray(samples) ? samples.filter(Boolean) : [];
    if (list.length === 0) return 0;
    let count = 0;
    for (const [key, articles] of farmIndex) {
      if (!list.some((sample) => X.farmSimilar(key, sample) >= FARM_SIMILARITY)) continue;
      for (const node of articles) {
        if (node === exclude || !node.isConnected) continue;
        if (node.dataset.jevxHidden === '1') continue;
        const tweet = X.parseTweet(node);
        hideArticle(node, tweet, {
          ...decision,
          band: 'hide',
          reasons: ['farm_repeat'],
          reasonLabels: ['文案农场：同一段文案被多个账号在短时间内复制刷屏'],
          source: 'farm',
          accountAction: { kind: 'none', execute: false, dryRun: true, reason: 'farm_retro' },
        });
        count += 1;
      }
    }
    return count;
  }

  function hideArticle(article, tweet, decision) {
    const key = X.tweetKey(tweet);
    const existing = state.hidden.get(key);
    if (existing && existing.article === article && article.dataset.jevxHidden === '1') return;
    // 隐藏优先：被过滤的推文不再保留 β 折叠条与 α 徽标（它们不是 .jevx-bar，会被隐藏 CSS 一起藏掉）。
    clearBeta(article);
    clearAlpha(article);
    clearEmotionBadge(article);
    const bar = buildBar(tweet, decision);
    article.querySelectorAll(':scope > .jevx-bar').forEach((el) => el.remove());
    article.appendChild(bar);
    article.dataset.jevxHidden = '1';
    article.dataset.jevxKey = key;
    state.hidden.set(key, { article, decision, at: Date.now() });
    audit('hidden', tweet, { decision: { band: decision.band, reasons: decision.reasons, source: decision.source } });
    updateBadge();
  }

  function showTweet(tweet) {
    const key = X.tweetKey(tweet);
    const entry = state.hidden.get(key);
    if (entry?.article) {
      entry.article.dataset.jevxHidden = '0';
      entry.article.querySelectorAll(':scope > .jevx-bar').forEach((el) => el.remove());
    }
    state.hidden.delete(key);
    audit('shown', tweet, {});
    updateBadge();
  }

  async function markFalsePositive(tweet, decision) {
    showTweet(tweet);
    await send('JEVX_WHITELIST_ADD', { handle: tweet.handle });
    audit('false_positive', tweet, { decision: { band: decision.band, reasons: decision.reasons } });
  }

  function unhideAll() {
    for (const [, entry] of state.hidden) {
      try {
        entry.article.dataset.jevxHidden = '0';
        entry.article.querySelectorAll(':scope > .jevx-bar').forEach((el) => el.remove());
      } catch {
        /* 节点可能已被回收 */
      }
    }
    state.hidden.clear();
    // β 折叠条与 α 徽标不在 state.hidden 里，必须单独清一遍（重置/重扫/关闭扩展时）。
    for (const article of S.findTweets(document)) {
      clearBeta(article);
      clearAlpha(article);
      clearEmotionBadge(article);
    }
    updateBadge();
  }

  function updateBadge() {
    if (!state.settings?.ui?.badge) return;
    void send('JEVX_BADGE', { count: state.hidden.size });
  }

  /* ------------------------------- 自动动作 ------------------------------- */

  /** Escape 的补发定时器：必须可取消，否则上一次失败的 300ms 延迟 Escape 会关掉这一次刚打开的菜单。 */
  let escapeTimer = null;

  function cancelPendingEscape() {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
  }

  function pressEscape() {
    // X 打开菜单后会把焦点移到菜单上，并把 Escape 监听挂在那里：
    // 派发给 document 是关不掉的（多个开源实现都踩过这个坑），必须派发给 activeElement。
    const target = document.activeElement ?? document.body;
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch {
      /* ignore */
    }
    cancelPendingEscape();
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      if (!S.getOpenMenu()) return;
      try {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
      } catch {
        /* ignore */
      }
    }, 300);
  }

  function nextFrame() {
    // 只等一帧让样式落定；后台标签页里 requestAnimationFrame 可能长期不触发，所以必须有超时兜底
    // （内联样式是同步生效的，这一帧只是礼貌，不能让它卡住整个动作队列）。
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, 120);
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => {
          clearTimeout(timer);
          finish();
        });
      } else {
        clearTimeout(timer);
        finish();
      }
    });
  }

  const RENDER_STYLE_PROPS = ['display', 'visibility', 'position', 'top', 'left', 'width', 'height', 'overflow', 'opacity'];

  function patchInlineStyle(el, css) {
    const saved = new Map();
    for (const prop of RENDER_STYLE_PROPS) {
      saved.set(prop, { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    }
    for (const [prop, value] of Object.entries(css)) el.style.setProperty(prop, value, 'important');
    return () => {
      for (const prop of RENDER_STYLE_PROPS) {
        const prev = saved.get(prop);
        if (prev?.value) el.style.setProperty(prop, prev.value, prev.priority);
        else el.style.removeProperty(prop);
      }
    };
  }

  /**
   * 让「被隐藏推文」里的 ⋯ 按钮临时恢复成「有盒子但不可见」。
   *
   * 根因（真站 `自动动作失败：menu_item_not_found:mute`）：推文被 `article[data-jevx-hidden=1] > *:not(.jevx-bar)`
   * 藏起来后，caret 的 bounding rect 是 0×0；X 的菜单浮层按**触发按钮的 rect** 定位，
   * 触发按钮没有盒子时菜单要么不渲染、要么渲染到视口外 —— 于是永远找不到菜单项。
   *
   * 处理：只把 caret→article 这一段祖先链改成 `display:block + visibility:hidden`（有盒子、不可见、不占高度），
   * caret 自身 1×1 固定在视口左上角。推文依旧不可见、不闪动、不改变隐藏语义；返回还原函数。
   */
  function makeTriggerRenderable(article, caret) {
    const restores = [];
    const isHiddenByStyle = (node) => {
      try {
        return globalThis.getComputedStyle?.(node)?.display === 'none';
      } catch {
        return false;
      }
    };
    try {
      for (let node = caret?.parentElement; node && node !== article; node = node.parentElement) {
        if (!isHiddenByStyle(node)) continue;
        restores.push(patchInlineStyle(node, { display: 'block', visibility: 'hidden' }));
      }
      restores.push(
        patchInlineStyle(caret, {
          display: 'block',
          visibility: 'hidden',
          position: 'fixed',
          top: '0px',
          left: '0px',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          opacity: '0',
        }),
      );
      // 读一次 rect 强制排版，保证点击时它已经有非零盒子。
      caret.getBoundingClientRect();
    } catch {
      /* 样式补丁失败也要尽量把菜单点出来：这里绝不抛 */
    }
    return () => {
      for (let i = restores.length - 1; i >= 0; i -= 1) {
        try {
          restores[i]();
        } catch {
          /* ignore */
        }
      }
    };
  }

  /**
   * 打开 ⋯ 菜单并挑出目标菜单项。三级阶梯：
   * 1. 原生 `.click()`（绝大多数构建）；
   * 2. 补一整套 pointer/mouse 序列但不补 click（少数构建把菜单挂在 mousedown/pointerdown 上，
   *    补 click 反而可能把它关掉）；
   * 3. 两者都补。
   * 每一级都等「新出现的、含 menuitem 的菜单」，失败先 Escape 关掉再试，绝不猜点。
   */
  const MENU_OPEN_ATTEMPTS = [
    { pointer: false, native: true, timeoutMs: 2500 },
    { pointer: true, native: false, timeoutMs: 2000 },
    { pointer: true, native: true, timeoutMs: 2000 },
  ];

  async function openMenuAndPick(caret, kind, handle) {
    const before = S.collectMenus();
    let sawMenu = false;
    let captured = null;
    for (const attempt of MENU_OPEN_ATTEMPTS) {
      cancelPendingEscape();
      S.clickElement(caret, { pointer: attempt.pointer, native: attempt.native });
      const menu = await S.waitFor(() => S.pickFreshMenu(before), { timeoutMs: attempt.timeoutMs });
      if (menu) {
        sawMenu = true;
        // 在菜单**还开着**的时候抓一份内容快照：失败后菜单已被 Escape 关掉，再查就只能查到残留节点了。
        if (!captured) captured = S.describeMenu(menu);
      }
      // 带上目标 handle：残留菜单里写的是别的账号，靠这一条也能拦住「静音错人」。
      const item = S.findMenuItem(kind, { menu, handle });
      if (item) return { item, menu, sawMenu, items: captured ?? [] };
      if (!captured) captured = S.describeMenu(null);
      pressEscape();
      await new Promise((r) => setTimeout(r, 350));
    }
    return { item: null, menu: null, sawMenu, items: captured ?? [] };
  }

  const ACTION_ERROR_TITLE = {
    caret_not_found: '找不到这条推文的 ⋯ 按钮',
    menu_not_opened: '点了 ⋯ 但菜单没有打开',
    menu_item_not_found: '菜单里没有对应的静音/拉黑项',
  };

  /** 把内部错误码翻译成人话（截图里那种 `menu_item_not_found:mute` 用户看不懂）。 */
  function humanActionError(code, kind) {
    const head = String(code).split(':')[0];
    const target = kind === 'block' ? '拉黑' : '静音';
    return `${ACTION_ERROR_TITLE[head] ?? '界面操作失败'}（目标：${target}）`;
  }

  async function waitForActionGap() {
    const gap = state.settings?.action?.actionDelayMs ?? 1500;
    const elapsed = Date.now() - state.lastActionAt;
    if (gap > elapsed) await new Promise((r) => setTimeout(r, gap - elapsed));
    state.lastActionAt = Date.now();
  }

  /**
   * 通过界面点击执行静音/拉黑（不调用任何私有 API，不伪造请求）。
   * 每一步都验证 DOM 状态并在超时后放弃，失败只记录、不重试轰炸。
   */
  async function performAccountAction(article, tweet, decision, options = {}) {
    if (!article || !decision?.accountAction) return false;
    const kinds = decision.accountAction.kind === 'both' ? ['mute', 'block'] : [decision.accountAction.kind];
    const dedupeKey = `${tweet?.handle ?? '?'}:${kinds.join('+')}`;
    if (options.force) acted.delete(dedupeKey);
    if (acted.has(dedupeKey)) {
      updateBarNote(article, `已处理过 @${tweet?.handle}（跳过重复动作）`);
      return true;
    }
    acted.add(dedupeKey);
    let restoreTrigger = () => {};
    try {
      for (const kind of kinds) {
        await waitForActionGap();
        const caret = S.getCaret(article);
        if (!caret) throw new Error('caret_not_found');
        // 记录点击前就存在的确认按钮：X 会复用 confirmationSheetConfirm 给别的弹窗，
        // 只认「新出现的那个」，避免误点一个早就挂着的对话框。
        const existingConfirms = S.snapshotConfirmButtons();
        // 被隐藏的推文先临时恢复 ⋯ 按钮的盒子，否则 X 的浮层拿不到锚点（见 makeTriggerRenderable）。
        if (article.dataset.jevxHidden === '1') {
          restoreTrigger();
          restoreTrigger = makeTriggerRenderable(article, caret);
          await nextFrame();
        }
        const found = await openMenuAndPick(caret, kind, tweet?.handle);
        if (!found.item) {
          const error = new Error(`${found.sawMenu ? 'menu_item_not_found' : 'menu_not_opened'}:${kind}`);
          error.menuDebug = { ...(S.menuDebug?.() ?? { menus: 0, rendered: 0 }), items: found.items ?? [] };
          throw error;
        }
        S.clickElement(found.item);
        if (kind === 'block') {
          const confirm = await S.waitFor(() => S.findConfirmButton(existingConfirms), { timeoutMs: 3000 });
          if (confirm) confirm.click();
        }
        await S.waitFor(() => !S.getOpenMenu(), { timeoutMs: 2500 });
      }
      state.actions += 1;
      state.lastActionError = null;
      audit('action', tweet, { accountAction: { ...decision.accountAction, executed: true } });
      updateBarNote(article, `已${kinds.includes('block') ? '拉黑' : '静音'} @${tweet.handle}`);
      return true;
    } catch (error) {
      state.errors += 1;
      acted.delete(dedupeKey); // 失败允许重试（例如菜单还没渲染出来）
      cancelPendingEscape();
      pressEscape();
      const code = String(error?.message ?? error);
      const debug = error?.menuDebug ?? S.menuDebug?.() ?? null;
      state.lastActionError = { code, handle: tweet?.handle ?? '', at: Date.now(), menu: debug };
      state.actionErrors.push(state.lastActionError);
      if (state.actionErrors.length > 10) state.actionErrors.shift();
      audit('action_failed', tweet, { accountAction: { ...decision.accountAction, executed: false }, error: code, menu: debug });
      const retryLabel = state.settings?.action?.autoBlock ? '立即拉黑' : '立即静音';
      updateBarNote(
        article,
        `自动动作失败：${humanActionError(code, kinds[kinds.length - 1])} · 可点「${retryLabel}」重试`,
        debug,
      );
      return false;
    } finally {
      restoreTrigger();
    }
  }

  function updateBarNote(article, text, debug = null) {
    const bar = article?.querySelector(':scope > .jevx-bar');
    if (!bar) return;
    let note = bar.querySelector('.jevx-note');
    if (!note) {
      note = document.createElement('span');
      note.className = 'jevx-score jevx-note';
      bar.appendChild(note);
    }
    note.textContent = text;
    if (debug) {
      const items = Array.isArray(debug.items) ? debug.items.filter(Boolean) : [];
      note.title = items.length
        ? `菜单里实际有：${items.join(' / ')}（菜单 ${debug.menus ?? 0} 个，其中可见 ${debug.rendered ?? 0} 个）`
        : `点开菜单后没有读到任何菜单项（菜单 ${debug.menus ?? 0} 个，其中可见 ${debug.rendered ?? 0} 个）`;
    }
  }

  /* ------------------------------- 主流程 ------------------------------- */

  function applyDecision(article, tweet, decision) {
    if (!state.settings?.enabled) return;
    const shouldHide = state.settings.action.hide && decision.band !== 'ignore';
    if (shouldHide) {
      hideArticle(article, tweet, decision);
    } else {
      // 纯增量呈现：α 徽标 + β 折叠条。两者都不改变隐藏判定，也不产生账号动作。
      applyAlphaMark(article, decision);
      applyEmotionBadge(article, decision);
      applyBetaFold(article, tweet, decision);
    }

    const action = decision.accountAction;
    if (!action || action.kind === 'none') return;
    if (action.execute) {
      void enqueueAction(() => performAccountAction(article, tweet, decision));
    } else {
      state.planned += 1;
      audit('action_planned', tweet, { accountAction: action, decision: { band: decision.band, reasons: decision.reasons } });
    }
  }

  /**
   * 内容签名：X 会把 cell/article 节点回收给另一条推文复用，
   * 只按「元素身份」记账会导致复用后的新推文继承上一条的隐藏状态（甚至被永久藏住）。
   * 因此每个元素上记「内容签名 + epoch」，两者都一致才跳过。
   *
   * 关键：签名只取推文自己的文案/作者节点，**不取整个 article 的 textContent** ——
   * 我们自己注入的判定条也在 article 里，否则每次隐藏都会让签名变化，
   * 于是「隐藏 → 签名变 → 重新判定 → 再隐藏 → 再动作」自我循环。
   */
  function signatureOf(article) {
    const id = S.getTweetId(article) ?? '';
    const name = article.querySelector('[data-testid="User-Name"]')?.textContent ?? '';
    const text = article.querySelector('[data-testid="tweetText"]')?.textContent ?? '';
    return `${id}:${X.hash32(`${name}|${text}`.slice(0, 200))}`;
  }

  function resetArticle(article) {
    const key = article.dataset.jevxKey;
    if (key) state.hidden.delete(key);
    article.dataset.jevxHidden = '0';
    article.querySelectorAll(':scope > .jevx-bar').forEach((el) => el.remove());
    // 节点被虚拟列表回收复用：β 折叠条、α 与情绪徽标必须一起清掉，否则新推文会继承上一条的呈现。
    clearBeta(article);
    clearAlpha(article);
    clearEmotionBadge(article);
  }

  /**
   * 单条推文的判定。
   *
   * 真站 DOM 千奇百怪（虚拟列表回收、标记为推文的容器其实没有文案、X 改版换了结构…），
   * 而调用方是 `void inspectArticle(article)` —— 这里一旦抛异常就会变成**未捕获的 Promise 异常**，
   * 在 chrome://extensions 上表现为扩展卡片的「错误」按钮。所有意外都在这里兜住：
   * 计数 + 记审计 + 标 `error` 态，绝不让它冒到外面。
   */
  async function inspectArticle(article) {
    if (!state.enabled || !article.isConnected) return;
    let tweet = null;
    try {
      tweet = X.parseTweet(article);
      if (!tweet.handle && !tweet.text && !tweet.hasMedia) return;
      const key = X.tweetKey(tweet);
      article.dataset.jevxKey = key;
      article.dataset.jevxState = 'pending';

      const response = await send('JEVX_DECIDE', { tweet });
      if (!response?.ok) {
        state.errors += 1;
        article.dataset.jevxState = 'error';
        audit('error', tweet, { error: response?.error ?? 'decide_failed' });
        return;
      }
      const decision = response.decision;
      state.decisions.set(key, decision);
      article.dataset.jevxState = decision.band;
      article.dataset.jevxSource = decision.source ?? '';
      const farmKey = indexFarm(article, tweet);
      applyDecision(article, tweet, decision);
      if (decision.farm?.hit) {
        const extra = retroHideFarm(decision.farm.samples ?? [farmKey ?? decision.farm.key], decision, article);
        if (extra > 0) {
          state.farmRetroHidden = (state.farmRetroHidden ?? 0) + extra;
          audit('farm_retro_hidden', tweet, { farm: decision.farm, extra });
        }
      }
    } catch (error) {
      holdError(article, tweet, error, 'inspect');
    }
  }

  /** 把意外兜住：计数、标错、记审计、写调试日志（不抛）。 */
  function holdError(article, tweet, error, stage) {
    state.errors += 1;
    state.lastError = { stage, error: String(error?.message ?? error), at: Date.now() };
    try {
      if (article?.dataset) article.dataset.jevxState = 'error';
    } catch {
      /* ignore */
    }
    try {
      audit('error', tweet, { error: state.lastError.error, stage });
    } catch {
      /* ignore */
    }
    log(`判定过程异常（已兜住 · ${stage}）`, state.lastError.error);
  }

  function registerArticle(article) {
    if (!state.enabled || !article.isConnected) return;
    try {
      const signature = signatureOf(article);
      if (article.dataset.jevxSig === signature && article.dataset.jevxEpoch === String(state.epoch)) return;
      if (article.dataset.jevxSig && article.dataset.jevxSig !== signature) {
        // 节点被复用成另一条推文：先还原，再按新内容重新判定
        resetArticle(article);
      }
      article.dataset.jevxSig = signature;
      article.dataset.jevxEpoch = String(state.epoch);
      if (state.settings?.scope?.onlyVisible && intersectionObserver) {
        intersectionObserver.observe(article);
        return;
      }
      void inspectArticle(article);
    } catch (error) {
      // 单条推文的 DOM 再奇怪也不能掀翻整轮扫描（否则同屏其它推文一起不判定了）。
      holdError(article, null, error, 'register');
    }
  }

  function scan() {
    if (!state.enabled) return;
    for (const article of S.findTweets(document)) registerArticle(article);
  }

  function scheduleScan(delay = 350) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  /** X 因为点赞/转推动画每秒会产生大量 childList 变更；无关的变更不必触发全量扫描。 */
  function isRelevantMutation(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute?.('data-testid')) return true;
        if (node.querySelector?.('[data-testid]')) return true;
      }
    }
    return false;
  }

  function startObservers() {
    if (!observer) {
      observer = new MutationObserver((mutations) => {
        if (isRelevantMutation(mutations)) scheduleScan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // 兜底巡检：节点在原地被换内容（没有 addedNodes）时，签名检查也能在 2.5s 内发现。
      globalThis.setInterval(() => scheduleScan(0), 2500);
    }
    if (!intersectionObserver) {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            intersectionObserver.unobserve(entry.target);
            void inspectArticle(entry.target);
          }
        },
        { rootMargin: '200px 0px', threshold: 0.01 },
      );
    }
  }

  function rescan() {
    unhideAll();
    state.epoch += 1;
    state.decisions.clear();
    scan();
  }

  function applySettings(settings) {
    const wasEnabled = state.enabled;
    state.settings = settings;
    state.enabled = Boolean(settings?.enabled);
    state.ownHandle = S.detectOwnHandle();
    globalThis.__jevxOwnHandle = state.ownHandle;
    if (!state.enabled) {
      unhideAll();
      return;
    }
    startObservers();
    if (!wasEnabled) {
      rescan();
    } else {
      scheduleScan(100);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'JEVX_SETTINGS_CHANGED' && message.settings) applySettings(message.settings);
    return false;
  });

  (async function boot() {
    const response = await send('JEVX_GET_SETTINGS');
    if (response?.ok) {
      applySettings(response.settings);
      log(`已启动 v${VERSION}`, response.settings);
    } else {
      log('无法读取设置', response?.error);
    }
    // SPA 路由切换（时间线 → 详情页 → 搜索页）时补扫一次
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScan(600);
      }
    }, 1200);
  })();

  /** 当前页面上带 β 折叠条 / α 徽标的推文数。展开后仍算「被 β 标记」，与 e2e 的 beta==='1' 口径一致。 */
  function countBetaMarked() {
    let count = 0;
    for (const article of S.findTweets(document)) if (article.dataset.jevxBeta === '1') count += 1;
    return count;
  }

  function countAlphaMarked() {
    let count = 0;
    for (const article of S.findTweets(document)) if (article.dataset.jevxAlpha === '1') count += 1;
    return count;
  }

  /** 供端到端测试与调试读取（只读）。 */
  globalThis.__jevxContent = {
    version: VERSION,
    state,
    summary: () => ({
      enabled: state.enabled,
      hidden: state.hidden.size,
      decisions: state.decisions.size,
      actions: state.actions,
      planned: state.planned,
      errors: state.errors,
      bands: [...state.decisions.values()].reduce((acc, d) => ({ ...acc, [d.band]: (acc[d.band] ?? 0) + 1 }), {}),
      farmIndex: farmIndex.size,
      farmRetroHidden: state.farmRetroHidden ?? 0,
      betaFolded: countBetaMarked(),
      alphaMarked: countAlphaMarked(),
      emotionMarked: S.findTweets(document).filter((a) => a.dataset.jevxEmotion).length,
      lastActionError: state.lastActionError ?? null,
      lastError: state.lastError ?? null,
      actionErrors: state.actionErrors.slice(-10),
    }),
  };
})();
