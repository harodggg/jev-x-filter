/**
 * 通用小工具（纯函数、无 DOM、无网络）。
 * Service Worker / 选项页 / Node 测试共用。
 */

/** FNV-1a 32 位哈希：用于缓存键，稳定且不依赖 crypto。 */
export function hash32(input) {
  const s = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 只合并 key 存在于 defaults 的字段（白名单合并），数组直接替换。
 * 这样 import 来的、被篡改的或旧版本的 settings 都不会注入未知字段。
 */
export function mergeKnown(defaults, patch) {
  const out = Array.isArray(defaults) ? defaults.slice() : { ...defaults };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    const base = out[key];
    if (isPlainObject(base) && isPlainObject(value)) out[key] = mergeKnown(base, value);
    else if (Array.isArray(base)) out[key] = Array.isArray(value) ? value.slice() : base;
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 截断到 n 个字符，避免把超长推文塞满模型上下文。 */
export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 极简滑动窗口计数器（用于每分钟预算）。 */
export class RateWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.stamps = [];
  }

  count(nowMs) {
    this.#evict(nowMs);
    return this.stamps.length;
  }

  /** 返回 true 表示已占用一个配额；false 表示超预算。 */
  tryTake(nowMs, limit) {
    this.#evict(nowMs);
    if (this.stamps.length >= limit) return false;
    this.stamps.push(nowMs);
    return true;
  }

  #evict(nowMs) {
    const cutoff = nowMs - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
  }
}
