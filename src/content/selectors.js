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

  /**
   * 菜单项文案表（多语言）——**先排除反义项，再按目标匹配**。
   *
   * 两个真站教训都体现在这里：
   * 1. 静音项没有 `data-testid`（拉黑有），只能靠文案；而文案前面可能带图标/双向控制符/前缀符号，
   *    旧实现用行首锚定（`^静音`）就会失配 → 「自动动作失败：menu_item_not_found:mute」。
   *    改成「非锚定包含」匹配。
   * 2. 「取消静音」包含「静音」、西语「Dejar de silenciar」包含「silenciar」、法语「Débloquer」包含
   *    「bloquer」——所以反义判断必须**先做**，否则会把「取消静音」当成「静音」点下去（点反）。
   */
  const LATIN_WORD = (word) => new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`, 'i');

  const MENU_LABEL = {
    mute: [
      // 英文 mute 是短词：必须带词边界，否则 `commuter` 之类会被误命中
      LATIN_WORD('mute'),
      /silenci/i,
      /silenzia/i,
      /stummschalt/i,
      /dempen/i,
      /tysta/i,
      /wycisz/i,
      /bisukan/i,
      /sessize/i,
      /静音/,
      /靜音/,
      /ミュート/,
      /음소거/,
      /заглуш/i,
      /كتم/,
      /ปิดเสียง/,
      /tắt tiếng/i,
      /म्यूट/,
    ],
    unmute: [
      LATIN_WORD('unmute'),
      // 「否定词 + 词根」的开放集（pt-BR / ca / es 都是这个结构），别只列固定短语
      /(?:deix(?:ar|a|e|es|em)|dej(?:ar|a|e|en))\s+de\s+silenciar/i,
      /desilenciar/i,
      /riattiva|attiva\s+l['’]?audio/i,
      /dempen[-\s]?opheffen/i,
      /odcisz|wyłącz\s+wyciszenie|włącz\s+dźwięk/i,
      /aktifkan/i,
      /sessizden/i,
      /désactiver\s+le\s+silence|réactiver\s+le\s+son/i,
      /取消静音|取消靜音|取消隐藏|取消隱藏/,
      /ミュート解除|ミュートを解除/,
      /음소거\s*해제/,
      /stummschaltung\s*(?:aufheben|beenden)/i,
      /разглуш|отменить заглуш|снять заглуш|включить звук/i,
      /إلغاء كتم/,
      /เปิดเสียง/,
      /bật tiếng/i,
      /अनम्यूट|म्यूट हटाएं/,
    ],
    block: [
      LATIN_WORD('block'),
      /blockier/i, // Blockieren / Blockierung
      /bloqu/i, // Bloquear / Bloquer / Bloqueie / Bloqueja（含 Débloquer/Desbloquear → 由反义项先拦）
      /blocca/i,
      /blokkeren/i,
      /blokuj/i,
      /blokow/i, // Zablokować / Zablokowane（含 Odblokować → 由反义项先拦）
      /blokir/i, // 含 Buka blokir → 由反义项先拦
      /engelle/i,
      /chặn/i, // 含 Bỏ chặn → 由反义项先拦
      /屏蔽|拉黑|封锁|封鎖/,
      /ブロック/,
      /차단/,
      /заблокировать/i,
      /حظر/,
      /บล็อก|ปิดกั้น/,
      /ब्लॉक/,
    ],
    unblock: [
      LATIN_WORD('unblock'),
      /débloquer|debloquer/i,
      /desbloqu|desbloque/i,
      /sblocca/i,
      /deblokkeren/i,
      /odblokow|odblokuj/i,
      /buka blokir/i,
      /engeli kaldır/i,
      /(?:deix(?:ar|a|e|es)|dej(?:ar|a|e))\s+de\s+bloqu/i,
      /désactiver\s+le\s+blocage|lever\s+le\s+blocage/i,
      /blockierung\s*(?:aufheben|beenden)|entsperren/i,
      /取消屏蔽|取消拉黑|取消封锁|取消封鎖|已屏蔽|已拉黑/,
      /ブロック解除|ブロックを解除/,
      /차단 해제/,
      /разблокировать/i,
      /إلغاء الحظر/,
      /เลิกบล็อก/,
      /bỏ chặn/i,
      /अनब्लॉक|ब्लॉक हटाएं/,
    ],
    confirm: [/^(?:block|屏蔽|拉黑|封锁|封鎖|ブロック|确认|確定|确定|confirm|ok)$/i],
  };

  /** 反义项：点反了比失败更糟（「静音」变「取消静音」）。 */
  const ANTI_ACTION = { mute: 'unmute', unmute: 'mute', block: 'unblock', unblock: 'block' };

  /** 与语言无关的 `data-testid`（拉黑/静音在部分构建里有）。 */
  const MENU_ITEM_TESTID = {
    mute: ['mute', 'muteLink'],
    unmute: ['unmute', 'unmuteLink'],
    block: ['block', 'blockLink'],
    unblock: ['unblock', 'unblockLink'],
  };

  const RECOMMENDED_HEADING = /推荐|为你推荐|发现更多|你可能|Recommended|Discover more|You might like|Trending/i;
  /**
   * X 自己给「可能的垃圾信息」分区写的标题（多语言）。命中只意味着**隐藏成待确认**，
   * 绝不据此动账号 —— X 的判断是参考，不是我们的证据。
   */
  const SPAM_SECTION_HEADING = /可能的垃圾信息|可能包含垃圾|疑似垃圾|可能包含敏感|可能含有垃圾|Probable spam|Possible spam|Possibly spam|Likely spam|Probably spam|Show probable spam|Spam replies|Hidden replies/i;
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

  /**
   * 推文是否落在 X 自己标注的**「可能的垃圾信息」分区**里。
   *
   * 真站样本（用户截图）：回复线程里 X 会把可疑回复折叠成一段，用户点开后那一段上方写着
   * 「可能的垃圾信息」，其中一条正文只有三个字（`已老实`）—— 内容层完全无解，
   * 但 **X 自己已经判过了**，这个标题就是一份免费的本地信号（和「推广」标记同一性质）。
   * 走法与 isRecommended 一样：往回找最近的标题节点，命中就认，最近的标题不是它就不认。
   */
  function isSpamSection(article) {
    let node = article.closest(SEL.cell.join(',')) ?? article;
    for (let hops = 0; hops < 6 && node; hops++) {
      for (let prev = node.previousElementSibling, depth = 0; prev && depth < 8; prev = prev.previousElementSibling, depth++) {
        if (!matchesAny(prev, SEL.heading)) continue;
        return SPAM_SECTION_HEADING.test(prev.textContent || '');
      }
      node = node.parentElement;
      if (matchesAny(node, SEL.primaryColumn)) break;
    }
    return false;
  }

  function isPromoted(article) {
    if (article.closest(SEL.promoted.join(','))) return true;
    const head = (article.innerText || '').slice(0, 400);    return /^(?:Promoted|推广|プロモーション)/m.test(head);
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

  function labelMatches(patterns, label) {
    if (!label || !Array.isArray(patterns)) return false;
    return patterns.some((re) => re.test(label));
  }

  /**
   * 需要「反义项优先」判定的动作 = 那些文案是**裸关键词**的动作。
   * 因为「取消静音」里含「静音」、「Débloquer」里含「bloquer」——不先排除就会点反。
   * 反义方向（unmute/unblock）不需要这一步：它的关键词本身就带否定前缀，
   * 裸的「静音/屏蔽」根本不会命中它（若也做反义判定，反而会把「取消静音」判成「不是取消静音」）。
   */
  const STRICT_ANTI = new Set(['mute', 'block']);

  /**
   * 「否定词 + 词根」的**开放集**护栏（只对 mute/block 生效，且只在目标词已经命中之后才看）：
   * `Deixar de silenciar`（pt-BR）、`Deixa de silenciar`（ca）、`Wyłącz wyciszenie`（pl）、
   * `取消屏蔽`、`ミュート解除`……这类文案里都含目标词根，逐条列举永远会漏一种语言，
   * 而漏一个就是「点反」。所以再加一条结构规则：文案里出现否定/撤销标记 → 判为反义，宁可不点。
   * 注意不要放「tắt」（越南语「关」）这类既是静音正例一部分、又表示否定的词。
   */
  const NEGATION_MARKER = /(?:deix|dej(?:ar|a|e|en)|取消|消除|解除|해제|aufheben|wyłącz|wylacz|désactive|disable|\boff\b|riattiva|disattiva|убрать|отменить|разблок|разглуш|إلغاء|bỏ)/i;

  /**
   * 纯函数：这个菜单项文案就是目标动作吗？
   * @param {'mute'|'unmute'|'block'|'unblock'} action
   * @param {string} label
   */
  function matchMenuLabel(action, label) {
    const wanted = MENU_LABEL[action];
    if (!wanted) return false;
    if (!labelMatches(wanted, label)) return false;
    if (STRICT_ANTI.has(action)) {
      const anti = MENU_LABEL[ANTI_ACTION[action]];
      if (anti && labelMatches(anti, label)) return false;
      if (NEGATION_MARKER.test(label)) return false;
    }
    return true;
  }

  function isConfirmLabel(label) {
    return labelMatches(MENU_LABEL.confirm, label);
  }

  function menuItemLabel(el) {
    const text = normalizeLabel(el?.textContent);
    if (text) return text;
    return normalizeLabel(el?.getAttribute?.('aria-label') ?? '');
  }

  function menuHasItems(el) {
    try {
      return Boolean(el?.querySelector?.('[role="menuitem"]'));
    } catch {
      return false;
    }
  }

  /** 元素在页面上真的有盒子（`display:none` 的祖先会让 rect 归零）。 */
  function isRendered(el) {
    if (!el?.getBoundingClientRect) return false;
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    } catch {
      return false;
    }
  }

  function collectMenus() {
    const out = [];
    for (const sel of SEL.dropdown) {
      try {
        for (const el of document.querySelectorAll(sel)) if (!out.includes(el)) out.push(el);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /**
   * 当前「打开着」的菜单。
   *
   * 为什么不能取 `querySelector` 的第一个：X 会把关闭过的 `Dropdown` 节点留在 DOM 里（甚至同时存在多个），
   * 第一个命中往往是残留节点——菜单里当然找不到刚点开的那一项，于是报 `menu_item_not_found`。
   * 规则：只认**真的有盒子**的、最靠后（最新层）的菜单；全是不可见残留节点时返回 null
   * （宁可让上层重试/失败，也不要去点一个残留节点上的旧菜单项）。
   */
  function getOpenMenu() {
    const withItems = collectMenus().filter(menuHasItems);
    if (withItems.length === 0) return null;
    const rendered = withItems.filter(isRendered);
    return rendered.length ? rendered[rendered.length - 1] : null;
  }

  /**
   * 点击之后**新出现**（或从不可见变成可见）的菜单。
   *
   * - 新出现的节点无条件可信（即使它被挂在被隐藏的子树里、暂时没有盒子）；
   * - `before` 里就有的节点只有在「现在是可见的」才可信 —— 那说明它刚刚被打开；
   * - 两者都没有 → null。绝不能退回不可见的残留节点：它的菜单项还绑着**上一个账号**的处理函数，
   *   点下去可能作用在错误的账号上。
   */
  function pickFreshMenu(before = []) {
    const withItems = collectMenus().filter(menuHasItems);
    if (withItems.length === 0) return null;
    const fresh = withItems.filter((el) => !before.includes(el));
    const reopened = withItems.filter((el) => before.includes(el) && isRendered(el));
    const pool = fresh.length ? fresh : reopened;
    if (pool.length === 0) return null;
    const rendered = pool.filter(isRendered);
    const chosen = rendered.length ? rendered : pool;
    return chosen[chosen.length - 1] ?? null;
  }

  function getMenuItems(menu) {
    if (!menu?.querySelectorAll) return [];
    try {
      return [...menu.querySelectorAll('[role="menuitem"], button')];
    } catch {
      return [];
    }
  }

  /**
   * 这一项是否**方向可疑**：`data-testid` 与文案指向相反动作时必须跳过。
   *
   * 背景（独立验证发现的缺口）：`data-testid="mute"` + 文案「取消静音 @x」这种自相矛盾的项，
   * 旧实现第一步只看 testid 就直接返回 → 点下去等于执行 unmute（「点反」比失败更糟）。
   * 现在：testid 是反义项、或文案是反义项 → 一律判为可疑并跳过；没有干净项就返回 null。
   */
  function isConflictingItem(el, action) {
    const antiAction = ANTI_ACTION[action];
    const antiIds = MENU_ITEM_TESTID[antiAction] ?? [];
    const id = el.getAttribute('data-testid');
    if (id && antiIds.includes(id)) return true;
    const label = menuItemLabel(el);
    if (label && matchMenuLabel(antiAction, label)) return true;
    return false;
  }

  /**
   * 文案里写的是**别人**的 handle 吗？
   *
   * X 的静音/拉黑菜单项文案带 handle（`静音 @someone`）。残留菜单节点上这类文案指向的是**上一个账号**，
   * 点下去会作用于错误的账号——所以当我们知道目标 handle 时，只接受「写了目标 handle」或「完全没写 handle」的项。
   */
  function labelHandleMismatch(label, expectedHandle) {
    const expected = String(expectedHandle ?? '').toLowerCase();
    if (!expected) return false;
    const mentioned = [...String(label ?? '').matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((m) => m[1].toLowerCase());
    if (mentioned.length === 0) return false;
    return !mentioned.includes(expected);
  }

  function findMenuItemIn(scope, action, options = {}) {
    if (!scope?.querySelectorAll) return null;
    const wanted = MENU_ITEM_TESTID[action] ?? [];
    const items = getMenuItems(scope).filter((el) => !isConflictingItem(el, action) && !labelHandleMismatch(menuItemLabel(el), options.handle));
    // 1) testid 优先：与语言无关，最不容易漂移
    const byTestId = items.find((el) => {
      const id = el.getAttribute('data-testid');
      return Boolean(id) && wanted.includes(id);
    });
    if (byTestId) return byTestId;
    // 2) 文案：反义项已在上面被排除
    return items.find((el) => matchMenuLabel(action, menuItemLabel(el))) ?? null;
  }

  /**
   * @param {'mute'|'block'} action
   * @param {{menu?: Element|null, handle?: string}} [options]
   */
  function findMenuItem(action, options = {}) {
    const scopes = [];
    if (options.menu?.isConnected) scopes.push(options.menu);
    const open = getOpenMenu();
    if (open && open !== options.menu) scopes.push(open);
    for (const scope of scopes) {
      const hit = findMenuItemIn(scope, action, options);
      if (hit) return hit;
    }
    // 兜底：只认页面上**有盒子**、方向与 handle 都不矛盾的 menuitem，绝不猜点菜单之外的按钮
    const wanted = MENU_ITEM_TESTID[action] ?? [];
    for (const el of document.querySelectorAll('[role="menuitem"]')) {
      if (!isRendered(el) || isConflictingItem(el, action)) continue;
      if (labelHandleMismatch(menuItemLabel(el), options.handle)) continue;
      const id = el.getAttribute('data-testid');
      if (id && wanted.includes(id)) return el;
      if (matchMenuLabel(action, menuItemLabel(el))) return el;
    }
    return null;
  }

  /** 诊断：失败时把「菜单里到底有什么」记下来（真站上只能靠这个定位选择器漂移）。 */
  function describeMenu(menu = null) {
    const scope = menu && menu.isConnected ? menu : getOpenMenu();
    let items = scope ? getMenuItems(scope) : [...document.querySelectorAll('[role="menuitem"]')];
    if (!scope) {
      // 菜单已经关掉时，优先看仍然可见的 menuitem，避免把残留（display:none）菜单的内容当成诊断
      const rendered = items.filter(isRendered);
      if (rendered.length) items = rendered;
    }
    return items
      .map((el) => {
        const label = menuItemLabel(el).slice(0, 20);
        const id = el.getAttribute('data-testid');
        return label || id || '';
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  function menuDebug() {
    const menus = collectMenus();
    return { menus: menus.length, rendered: menus.filter(isRendered).length, items: describeMenu() };
  }

  /**
   * 点击元素。默认走原生 `.click()`（React 的 onClick 收得到）。
   * `pointer: true` 时补一整套 pointer/mouse 序列（少数构建把菜单挂在 mousedown/pointerdown 上），
   * `native: false` 时**不**再补 `.click()`，避免「mousedown 打开 + click 关闭」的构建被自己关掉。
   */
  function clickElement(el, { pointer = false, native = true } = {}) {
    if (!el) return false;
    try {
      el.focus?.({ preventScroll: true });
    } catch {
      /* ignore */
    }
    if (pointer) {
      const base = { bubbles: true, cancelable: true, composed: true, view: globalThis };
      const fire = (type, extra) => {
        try {
          const hasPointer = typeof globalThis.PointerEvent === 'function';
          const Ctor = type.startsWith('pointer') && hasPointer ? globalThis.PointerEvent : globalThis.MouseEvent;
          el.dispatchEvent(new Ctor(type, { ...base, ...extra }));
        } catch {
          /* ignore */
        }
      };
      fire('pointerdown', { pointerId: 1, isPrimary: true, button: 0, buttons: 1 });
      fire('mousedown', { button: 0, buttons: 1, detail: 1 });
      fire('pointerup', { pointerId: 1, isPrimary: true, button: 0, buttons: 0 });
      fire('mouseup', { button: 0, buttons: 0, detail: 1 });
    }
    if (!native) return true;
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
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
        if (!label || isConfirmLabel(label)) return btn;
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
    MENU_ITEM_TESTID,
    SPAM_SECTION_HEADING,
    ANTI_ACTION,
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
    isSpamSection,
    detectOwnHandle,
    getCaret,
    getOpenMenu,
    pickFreshMenu,
    findMenuItem,
    matchMenuLabel,
    labelHandleMismatch,
    isConfirmLabel,
    describeMenu,
    menuDebug,
    clickElement,
    isRendered,
    collectMenus,
    findConfirmButton,
    snapshotConfirmButtons,
    normalizeLabel,
    stripInvisible,
    waitFor,
    upsizeImage,
  };
})(globalThis);
