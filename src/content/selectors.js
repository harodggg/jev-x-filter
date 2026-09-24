/**
 * x.com DOM 选择器与定位策略（内容脚本，传统脚本，通过 globalThis 共享）。
 *
 * X 的 class 名是随机构建的，唯一可依赖的是 `data-testid`；但 testid 也会随版本漂移，
 * 所以每个定位都写成「主选择器 + 回退链」，并且宁可返回 null 也不猜。
 * 改版时只需要动这一个文件。
 *
 * 各项选择器的取舍依据（对照 8 个仍在维护的开源 X 扩展的实际源码）：
 * - 菜单项优先用 `[role="menuitem"][data-testid="block"]`（与语言无关），
 *   静音没有 testid，只能按文案匹配，且必须**先排除 Unmute/取消静音**（否则会点反）。
 * - 引文判定用「引用祖先回溯」算法，且回溯时**不检查 owner 自己**。
 * - 焦点推文（详情页）是 `article[tabindex="-1"]`，时间线里是 `[tabindex="0"]`。
 * - “为你推荐”模块的语言无关特征是 `h2[role="heading"]` 的**下一个兄弟节点带 dir 属性**。
 * - 广告推文在 `[data-testid="placementTracking"]` 里。
 * - 关闭菜单要把 Escape 派发给 `document.activeElement`，派发给 document 无效。
 */
(function initSelectors(root) {
  'use strict';

  const SEL = {
    tweet: ['article[data-testid="tweet"]', 'article[role="article"]', '[data-testid="cellInnerDiv"] article'],
    cell: ['[data-testid="cellInnerDiv"]'],
    primaryColumn: ['[data-testid="primaryColumn"]'],
    text: ['[data-testid="tweetText"]'],
    userName: ['[data-testid="User-Name"]'],
    caret: [
      '[data-testid="caret"]',
      'button[data-testid="caret"]',
      'div[data-testid="caret"][role="button"]',
      'button[aria-haspopup="menu"]',
      'div[aria-haspopup="menu"][role="button"]',
      'button[aria-label="More"]',
    ],
    dropdown: ['div[data-testid="Dropdown"]', 'div[role="menu"]', '[data-testid="sheetDialog"]'],
    menuItem: ['[role="menuitem"]'],
    confirm: [
      'button[data-testid="confirmationSheetConfirm"]',
      '[data-testid="confirmationSheetDialog"] button',
      '[data-testid="confirmationSheet"] button',
      '[role="dialog"] button',
    ],
    photo: ['[data-testid="tweetPhoto"] img', 'img[src*="pbs.twimg.com/media"]'],
    videoHost: ['[data-testid="videoPlayer"]', '[data-testid="videoComponent"]', '[data-testid="tweetVideo"]'],
    card: ['[data-testid="card.wrapper"]', '[data-testid="card.layoutLarge.media"]'],
    socialContext: ['[data-testid="socialContext"]'],
    promoted: ['[data-testid="placementTracking"]'],
    heading: ['[role="heading"]'],
    statusLink: ['a[href*="/status/"]'],
    toast: ['[data-testid="toast"]', '[role="alert"]'],
    focused: ['article[data-testid="tweet"][tabindex="-1"]'],
    inTimeline: ['article[data-testid="tweet"][tabindex="0"]'],
  };

  /** 引文容器：回溯时遇到这些就说明这段文案属于被引用的推文。 */
  const QUOTE_ANCESTOR = ['article', '[data-testid="tweet"]', 'div[role="link"][tabindex="0"]', '[data-testid="quoteTweet"]'];

  // 文案匹配用：先剔除 bidi 控制符与 X 包裹用的引号，再判断（避免 RTL / 全角引号导致匹配失败）。
  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const WRAPPERS = /[\u0022\u0027\u2018\u2019\u201c\u201d\u300c\u300d\uff02]/g;

  const MENU_LABEL = {
    mute: /^(?:mute|静音|ミュート|음소거|stummschalten)/i,
    unmute: /^(?:unmute|取消静音|取消隐藏|ミュート解除|음소거\s*해제|stummschaltung)/i,
    block: /^(?:block|屏蔽|拉黑|封锁|封鎖|ブロック)/i,
    unblock: /^(?:unblock|取消屏蔽|已屏蔽|ブロック解除|ブロックを解除)/i,
    confirm: /^(?:block|屏蔽|拉黑|封锁|封鎖|ブロック|确认|確定|确定|confirm|ok)$/i,
  };

  const RECOMMENDED_HEADING = /推荐|为你推荐|发现更多|你可能|Recommended|Discover more|You might like|Trending/i;
  const REPLY_MARKER = /^(?:Replying to|正在回复|回复)\s*/i;
  const GENERIC_ALT = /^(?:image|photo|picture|图片|图像|照片|media|视频|video)$/i;
  const PROFILE_HREF = /^\/([A-Za-z0-9_]{1,15})\/?$/;

  function q1(rootEl, selectors) {
    for (const sel of selectors) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch {
        /* 选择器不被支持时跳过 */
      }
    }
    return null;
  }

  function qa(rootEl, selectors) {
    const out = [];
    for (const sel of selectors) {
      try {
        for (const el of rootEl.querySelectorAll(sel)) if (!out.includes(el)) out.push(el);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  function findTweets(rootEl) {
    return qa(rootEl ?? document, SEL.tweet);
  }

  function matchesAny(el, selectors) {
    for (const sel of selectors) {
      try {
        if (el.matches(sel)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /**
   * 回溯 el 到 owner（不含 owner）：途中只要碰到引文容器，就说明这段内容属于被引用的推文。
   * 「不含 owner」是关键 —— 否则每条推文的文案都会被判成引文，结果是全站零命中。
   */
  function insideQuote(el, owner) {
    for (let node = el.parentElement; node && node !== owner; node = node.parentElement) {
      if (matchesAny(node, QUOTE_ANCESTOR)) return true;
    }
    return false;
  }

  function stripInvisible(text) {
    return String(text ?? '').replace(BIDI, '').replace(WRAPPERS, '').replace(/\s+/g, ' ').trim();
  }

  function normalizeLabel(text) {
    return stripInvisible(text);
  }

  /* ------------------------------- 抽取 ------------------------------- */

  function ownTextNodes(article) {
    return qa(article, SEL.text).filter((el) => !insideQuote(el, article));
  }

  function getText(article) {
    const nodes = ownTextNodes(article);
    if (nodes.length === 0) return '';
    // 内联 emoji 是 <img alt="…">，textContent 会丢，所以用 innerText 兜底再拼 alt。
    const node = nodes[0];
    const inner = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    return inner;
  }

  function getQuotedText(article) {
    const nodes = qa(article, SEL.text).filter((el) => insideQuote(el, article));
    if (nodes.length === 0) return '';
    return nodes
      .map((el) => (el.innerText || el.textContent || '').trim())
      .join(' ')
      .slice(0, 400);
  }

  function authorBlocks(article) {
    return qa(article, SEL.userName).filter((el) => !insideQuote(el, article));
  }

  function getHandle(article) {
    const blocks = authorBlocks(article);
    // 首选：主页链接的 href（形如 /handle），不依赖显示名文案。
    for (const block of blocks) {
      for (const link of block.querySelectorAll('a[href]')) {
        const m = PROFILE_HREF.exec(stripInvisible(link.getAttribute('href')));
        if (m) return m[1].toLowerCase();
      }
    }
    // 回退：X 把 @handle 放在 tabindex="-1" 的元素里。
    for (const block of blocks) {
      const text = stripInvisible(block.querySelector('[tabindex="-1"]')?.textContent);
      const m = /@([A-Za-z0-9_]{1,15})/.exec(text);
      if (m) return m[1].toLowerCase();
    }
    for (const block of blocks) {
      const m = /@([A-Za-z0-9_]{1,15})/.exec(stripInvisible(block.textContent));
      if (m) return m[1].toLowerCase();
    }
    // 最后：从状态链接里取作者
    const status = firstStatusLink(article);
    const m = status && /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(status);
    return m ? m[1].toLowerCase() : '';
  }

  function getDisplayName(article) {
    const block = authorBlocks(article)[0];
    if (!block) return '';
    // X 的 User-Name 里：第一个链接是显示名，随后是 @handle，再往后是时间链接。
    // 显示名是黄推的重要载体（正文写得无害、引流全写在名字里），所以取「第一个不以 @ 开头的链接文本」。
    for (const link of block.querySelectorAll('a[href]')) {
      const text = stripInvisible(link.textContent);
      if (!text || text.startsWith('@')) continue;
      return text.slice(0, 60);
    }
    return stripInvisible(block.textContent)
      .replace(/@[A-Za-z0-9_]{1,15}/g, '')
      .replace(/\b\d+[smhd]\b/g, '')
      .trim()
      .slice(0, 60);
  }

  function firstStatusLink(article) {
    const time = article.querySelector('time');
    const anchor = time?.closest('a[href*="/status/"]');
    if (anchor) return anchor.getAttribute('href');
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    const best = links.find((link) => !/\/(?:photo|video|analytics)\/\d+/.test(link.getAttribute('href') ?? ''));
    return best ? best.getAttribute('href') : null;
  }

  function getTweetId(article) {
    const href = firstStatusLink(article);
    const m = href && /\/status\/(\d{5,25})/.exec(href);
    if (m) return m[1];
    return article.getAttribute('data-jevx-id') || null;
  }

  function upsizeImage(url, size = 'small') {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      if (u.hostname.endsWith('twimg.com')) u.searchParams.set('name', size);
      return u.toString();
    } catch {
      return url;
    }
  }

  function getMedia(article) {
    const urls = [];
    for (const img of qa(article, SEL.photo)) {
      if (insideQuote(img, article)) continue;
      const sized = upsizeImage(img.currentSrc || img.src, 'small');
      if (sized && !urls.includes(sized)) urls.push(sized);
    }
    for (const video of article.querySelectorAll('video[poster]')) {
      if (insideQuote(video, article)) continue;
      const poster = video.getAttribute('poster');
      if (poster && !urls.includes(poster)) urls.push(poster);
    }
    return urls.slice(0, 4);
  }

  function getAltText(article) {
    const parts = [];
    for (const img of article.querySelectorAll('img[alt]')) {
      if (insideQuote(img, article)) continue;
      const alt = stripInvisible(img.getAttribute('alt'));
      if (!alt || GENERIC_ALT.test(alt) || alt.length < 4) continue;
      parts.push(alt.slice(0, 200));
    }
    return parts.join(' | ').slice(0, 400);
  }

  function getCardText(article) {
    const cards = qa(article, SEL.card).filter((el) => !insideQuote(el, article));
    if (cards.length === 0) return '';
    return stripInvisible(cards[0].innerText).slice(0, 300);
  }

  function getContext(article) {
    const replyLink = [...article.querySelectorAll('a[href^="/"]')].find((a) => REPLY_MARKER.test(stripInvisible(a.textContent)));
    if (replyLink) return 'reply';
    if (isRecommended(article)) return 'recommended';
    return 'timeline';
  }

  /**
   * 语言无关的「推荐流」判定：最近的上级标题若是 Discover-more 形态
   * （`[role="heading"]` 的下一个兄弟节点带 dir 属性），或标题文案命中多语言表，则视为推荐。
   */
  function isRecommended(article) {
    let node = article.closest(SEL.cell.join(',')) ?? article;
    for (let hops = 0; hops < 6 && node; hops++) {
      for (let prev = node.previousElementSibling, depth = 0; prev && depth < 8; prev = prev.previousElementSibling, depth++) {
        if (!matchesAny(prev, SEL.heading)) continue;
        const next = prev.nextElementSibling;
        if (next && next.tagName === 'DIV' && next.hasAttribute('dir')) return true;
        if (RECOMMENDED_HEADING.test(prev.textContent || '')) return true;
        return false; // 最近的一个标题不是推荐分界，就按普通时间线处理
      }
      node = node.parentElement;
      if (matchesAny(node, SEL.primaryColumn)) break;
    }
    return false;
  }

  function isPromoted(article) {
    if (article.closest(SEL.promoted.join(','))) return true;
    const head = (article.innerText || '').slice(0, 400);
    return /^(?:Promoted|推广|プロモーション)/m.test(head);
  }

  function detectOwnHandle() {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!switcher) return '';
    const m = /@([A-Za-z0-9_]{1,15})/.exec(stripInvisible(switcher.innerText));
    return m ? m[1].toLowerCase() : '';
  }

  function isOwn(article) {
    const own = root.__jevxOwnHandle;
    return Boolean(own) && getHandle(article) === own;
  }

  function isFocused(article) {
    return article.getAttribute('tabindex') === '-1';
  }

  /* ------------------------------- 菜单与动作 ------------------------------- */

  function getCaret(article) {
    return q1(article, SEL.caret);
  }

  function getOpenMenu() {
    return q1(document, SEL.dropdown);
  }

  /**
   * @param {'mute'|'block'} action
   */
  function findMenuItem(action) {
    const menu = getOpenMenu();
    if (!menu) return null;
    const items = [...menu.querySelectorAll('[role="menuitem"], button')];

    if (action === 'block') {
      // 与语言无关：X 给拉黑菜单项带 data-testid="block"（unblock 是另一个 testid）
      const byTestId = items.find((el) => el.getAttribute('data-testid') === 'block');
      if (byTestId) return byTestId;
    }

    const matcher = MENU_LABEL[action];
    const anti = MENU_LABEL[action === 'mute' ? 'unmute' : 'unblock'];
    if (!matcher) return null;
    // 先排除反义项（Unmute/Unblock），再按文案匹配，避免点反。
    return items.find((el) => {
      const label = normalizeLabel(el.textContent);
      if (!label || anti.test(label)) return false;
      return matcher.test(label);
    }) ?? null;
  }

  /** 已存在的确认按钮集合：X 会复用 confirmationSheetConfirm 给别的弹窗，必须只点新出现的那个。 */
  function snapshotConfirmButtons() {
    return new Set(qa(document, SEL.confirm));
  }

  function findConfirmButton(exclude = new Set()) {
    for (const sel of SEL.confirm) {
      for (const btn of document.querySelectorAll(sel)) {
        if (exclude.has(btn)) continue;
        const label = normalizeLabel(btn.textContent);
        if (!label || MENU_LABEL.confirm.test(label)) return btn;
      }
    }
    return null;
  }

  function waitFor(predicate, { timeoutMs = 4000, intervalMs = 60 } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let value = null;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  root.JevXSelectors = {
    SEL,
    MENU_LABEL,
    QUOTE_ANCESTOR,
    findTweets,
    getText,
    getQuotedText,
    getHandle,
    getDisplayName,
    getTweetId,
    getMedia,
    getAltText,
    getCardText,
    getContext,
    isPromoted,
    isOwn,
    isFocused,
    isRecommended,
    detectOwnHandle,
    getCaret,
    getOpenMenu,
    findMenuItem,
    findConfirmButton,
    snapshotConfirmButtons,
    normalizeLabel,
    stripInvisible,
    waitFor,
    upsizeImage,
  };
})(globalThis);
