/**
 * 把 DOM 里的 <article> 归一化成「推文对象」。
 * 判定侧（Service Worker）只认这个结构，DOM 细节全部留在内容脚本里。
 */
(function initExtract(root) {
  'use strict';

  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 当前页面所属的推文 id：详情页 URL `/…/status/<id>` 里的数字。
   * SW 用它把同一条推文下的回复归入同一上下文做 α（与评论区多数观点不同）判定；
   * 不在详情页时为 null。注意这里只看 pathname，页面上的链接不算。
   */
  function threadId() {
    const match = /\/status\/(\d{5,25})/.exec(location.pathname);
    return match ? match[1] : null;
  }

  /**
   * @param {Element} article article[data-testid="tweet"]
   * @returns {object} 归一化推文
   */
  function parseTweet(article) {
    const S = root.JevXSelectors;
    const media = S.getMedia(article);
    const text = S.getText(article);
    const handle = S.getHandle(article);
    return {
      id: S.getTweetId(article),
      threadId: threadId(),
      handle,
      displayName: S.getDisplayName(article),
      text,
      quotedText: S.getQuotedText(article),
      altText: S.getAltText(article),
      cardText: S.getCardText(article),
      media,
      hasMedia: media.length > 0,
      context: S.getContext(article),
      promoted: S.isPromoted(article),
      // X 自己把这条放在「可能的垃圾信息」分区里（免费的本地信号，只用于隐藏成待确认）
      spamSection: typeof S.isSpamSection === 'function' ? S.isSpamSection(article) : false,
      isOwn: S.isOwn(article),
      lang: article.getAttribute('lang') || document.documentElement.lang || '',
      permalink: location.href,
    };
  }

  /**
   * 文案农场键：与 src/sw/farm.js 的 farmKey 完全同一套归一化规则
   * （NFKC → 去零宽 → 只留 CJK/字母数字 → 小写），短于 8 个有效字符返回 null（与 farm.js 的 FARM_MIN_CHARS 一致，有单测锁住）。
   * 内容脚本是传统脚本、不能 import，所以这里复制一份；单测会断言两边结果一致，防止漂移。
   */
  function farmKey(text) {
    const normalized = String(text ?? '')
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
      .toLowerCase()
      .replace(/[^\u3400-\u9fff\u3040-\u30ffa-z0-9]/g, '');
    return normalized.length < 8 ? null : normalized;
  }

  /** 字符 3-gram 集合。 */
  function farmShingles(text, n = 3) {
    const t = String(text ?? '');
    const set = new Set();
    if (t.length < n) {
      if (t) set.add(t);
      return set;
    }
    for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
    return set;
  }

  /**
   * 近似文案比较（与 src/sw/farm.js 的 farmSimilarity 同一套算法：3-gram 重叠系数 + 长度比护栏）。
   * 内容脚本是传统脚本、不能 import，所以复制一份；单测会断言两边结果一致，防止漂移。
   */
  function farmSimilar(a, b) {
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    if (!sa && !sb) return 1;
    if (!sa || !sb) return 0;
    if (sa === sb) return 1;
    const ratio = Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
    if (ratio < 0.5) return 0;
    const setA = farmShingles(sa);
    const setB = farmShingles(sb);
    const smaller = setA.size <= setB.size ? setA : setB;
    const larger = smaller === setA ? setB : setA;
    if (smaller.size === 0) return 0;
    let inter = 0;
    for (const g of smaller) if (larger.has(g)) inter += 1;
    return inter / smaller.size;
  }

  /** 稳定键：优先推文 id，其次「作者 + 文案」哈希（转推/重复渲染也能去重）。 */
  function tweetKey(tweet) {
    if (tweet?.id) return `id:${tweet.id}`;
    return `h:${hash32(`${tweet?.handle ?? ''}|${tweet?.text ?? ''}`)}`;
  }

  root.JevXExtract = { parseTweet, tweetKey, farmKey, farmSimilar, hash32 };
})(globalThis);
