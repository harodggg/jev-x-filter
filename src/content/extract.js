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
      isOwn: S.isOwn(article),
      lang: article.getAttribute('lang') || document.documentElement.lang || '',
      permalink: location.href,
    };
  }

  /**
   * 文案农场键：与 src/sw/farm.js 的 farmKey 完全同一套归一化规则
   * （NFKC → 去零宽 → 只留 CJK/字母数字 → 小写），短于 10 个有效字符返回 null。
   * 内容脚本是传统脚本、不能 import，所以这里复制一份；单测会断言两边结果一致，防止漂移。
   */
  function farmKey(text) {
    const normalized = String(text ?? '')
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
      .toLowerCase()
      .replace(/[^\u3400-\u9fff\u3040-\u30ffa-z0-9]/g, '');
    return normalized.length < 10 ? null : normalized;
  }

  /** 稳定键：优先推文 id，其次「作者 + 文案」哈希（转推/重复渲染也能去重）。 */
  function tweetKey(tweet) {
    if (tweet?.id) return `id:${tweet.id}`;
    return `h:${hash32(`${tweet?.handle ?? ''}|${tweet?.text ?? ''}`)}`;
  }

  root.JevXExtract = { parseTweet, tweetKey, farmKey, hash32 };
})(globalThis);
