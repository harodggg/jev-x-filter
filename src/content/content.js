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
  const VERSION = '0.2.0';

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
    tag.textContent =
      decision.band === 'block' ? '已过滤（高置信度）' : decision.band === 'review' ? '疑似黄推（待确认）' : '已过滤';
    bar.appendChild(tag);

    const score = document.createElement('span');
    score.className = 'jevx-score';
    const detail = decision.detail ?? {};
    const parts = [];
    if (typeof detail.adult === 'number') parts.push(`色情概率 ${(detail.adult * 100).toFixed(0)}%`);
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

  /** 记录 article 与它的农场键，供农场命中时追溯隐藏。 */
  function indexFarm(article, tweet) {
    const key = X.farmKey(tweet?.text);
    if (!key) return null;
    const list = farmIndex.get(key) ?? [];
    if (!list.includes(article)) list.push(article);
    farmIndex.set(key, list);
    return key;
  }

  /** 农场命中：把同文案的其它推文也隐藏（纯展示层，不产生账号动作）。 */
  function retroHideFarm(key, decision, exclude) {
    if (!key) return 0;
    const others = (farmIndex.get(key) ?? []).filter((node) => node !== exclude && node.isConnected);
    let count = 0;
    for (const node of others) {
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
    return count;
  }

  function hideArticle(article, tweet, decision) {
    const key = X.tweetKey(tweet);
    const existing = state.hidden.get(key);
    if (existing && existing.article === article && article.dataset.jevxHidden === '1') return;
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
    updateBadge();
  }

  function updateBadge() {
    if (!state.settings?.ui?.badge) return;
    void send('JEVX_BADGE', { count: state.hidden.size });
  }

  /* ------------------------------- 自动动作 ------------------------------- */

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
    setTimeout(() => {
      if (!S.getOpenMenu()) return;
      try {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
      } catch {
        /* ignore */
      }
    }, 300);
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
    try {
      for (const kind of kinds) {
        await waitForActionGap();
        const caret = S.getCaret(article);
        if (!caret) throw new Error('caret_not_found');
        // 记录点击前就存在的确认按钮：X 会复用 confirmationSheetConfirm 给别的弹窗，
        // 只认「新出现的那个」，避免误点一个早就挂着的对话框。
        const existingConfirms = S.snapshotConfirmButtons();
        caret.click();
        const item = await S.waitFor(() => S.findMenuItem(kind), { timeoutMs: 3000 });
        if (!item) {
          pressEscape();
          throw new Error(`menu_item_not_found:${kind}`);
        }
        item.click();
        if (kind === 'block') {
          const confirm = await S.waitFor(() => S.findConfirmButton(existingConfirms), { timeoutMs: 3000 });
          if (confirm) confirm.click();
        }
        await S.waitFor(() => !S.getOpenMenu(), { timeoutMs: 2500 });
      }
      state.actions += 1;
      audit('action', tweet, { accountAction: { ...decision.accountAction, executed: true } });
      updateBarNote(article, `已${kinds.includes('block') ? '拉黑' : '静音'} @${tweet.handle}`);
      return true;
    } catch (error) {
      state.errors += 1;
      acted.delete(dedupeKey); // 失败允许重试（例如菜单还没渲染出来）
      pressEscape();
      audit('action_failed', tweet, { accountAction: { ...decision.accountAction, executed: false }, error: String(error?.message ?? error) });
      updateBarNote(article, `自动动作失败：${String(error?.message ?? error)}`);
      return false;
    }
  }

  function updateBarNote(article, text) {
    const bar = article?.querySelector(':scope > .jevx-bar');
    if (!bar) return;
    let note = bar.querySelector('.jevx-note');
    if (!note) {
      note = document.createElement('span');
      note.className = 'jevx-score jevx-note';
      bar.appendChild(note);
    }
    note.textContent = text;
  }

  /* ------------------------------- 主流程 ------------------------------- */

  function applyDecision(article, tweet, decision) {
    if (!state.settings?.enabled) return;
    const shouldHide = state.settings.action.hide && decision.band !== 'ignore';
    if (shouldHide) hideArticle(article, tweet, decision);

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
  }

  async function inspectArticle(article) {
    if (!state.enabled || !article.isConnected) return;
    const tweet = X.parseTweet(article);
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
      const extra = retroHideFarm(farmKey ?? decision.farm.key, decision, article);
      if (extra > 0) {
        state.farmRetroHidden = (state.farmRetroHidden ?? 0) + extra;
        audit('farm_retro_hidden', tweet, { farm: decision.farm, extra });
      }
    }
  }

  function registerArticle(article) {
    if (!state.enabled || !article.isConnected) return;
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
    }),
  };
})();
