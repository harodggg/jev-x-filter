/**
 * 文案农场检测（重复刷屏）—— 又一条「不靠词表」的信号。
 *
 * 真站形态：同一段文案在 1 分钟内被 4 个随机账号（@ThomasTurnyysr / @TinaMysersyro /
 * @TimothyAndjqqx / @TeresaHarr8nsx）作为回复刷出来，显示名各带一个女性 emoji。
 * 单看任意一条，连模型都只能说「不确定」（实测 bait=0.54）；但「同一段无实质内容的话
 * 被 N 个不同账号在短时间内复制」本身就是 spam 农场的强证据。
 *
 * 设计要点：
 * - 归一到「只留 CJK 与字母数字」，去掉 emoji、标点、大小写、空白 —— 换 emoji/标点是刷屏者最常用的规避；
 * - 只统计**不同账号**（同一账号重复转发不算农场）；
 * - 内容太短（<10 个有效字符）不参与，避免「哈哈」「太好了」这种大众短语造成误伤；
 * - 默认 **2 个不同账号**即视为农场（生产里由 settings.farm.minAccounts 覆盖）：
 *   动手前 gate 还要求至少一条色情/诱饵/本地信号，所以「两个人恰好发同一句长句」不会误伤；
 * - 命中后只给 `hide` 档（可被用户的「隐藏档也静音」开关放大），绝不单独触发 block。
 */

/** 归一化：NFKC → 去零宽 → 只留 CJK/字母数字。 */
export function normalizeFarmText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/[^\u3400-\u9fff\u3040-\u30ffa-z0-9]/g, '');
}

/** 太短（信息量不足）的文案不参与农场判定。 */
export const FARM_MIN_CHARS = 10;

/** @returns {string|null} 农场键（归一化文案），内容太短返回 null。 */
export function farmKey(text) {
  const normalized = normalizeFarmText(text);
  if (normalized.length < FARM_MIN_CHARS) return null;
  return normalized;
}

export function createFarmTracker(options = {}) {
  const {
    windowMs = options.windowMs ?? 1800000, // 30 分钟
    minAccounts = options.minAccounts ?? 2,
    maxKeys = options.maxKeys ?? 500,
    now = () => Date.now(),
  } = options;
  let windowMsCurrent = windowMs;
  let minAccountsCurrent = minAccounts;

  /** @type {Map<string, {ts:number, handles:Set<string>}[]>} */
  const seen = new Map();

  function evict(nowMs) {
    const cutoff = nowMs - windowMsCurrent;
    for (const [key, entries] of seen) {
      const kept = entries.filter((entry) => entry.ts > cutoff);
      if (kept.length === 0) seen.delete(key);
      else if (kept.length !== entries.length) seen.set(key, kept);
    }
    while (seen.size > maxKeys) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
  }

  return {
    /**
     * 记一条推文，返回农场判定。
     * @returns {{hit: boolean, key: string|null, accounts: number}}
     */
    record(text, handle, options2 = {}) {
      const key = farmKey(text);
      if (!key) return { hit: false, key: null, accounts: 0 };
      const nowMs = options2.nowMs ?? now();
      evict(nowMs);
      const entries = seen.get(key) ?? [];
      const normalizedHandle = String(handle ?? '').replace(/^@+/, '').toLowerCase() || `#anon:${key.length}`;
      const existing = entries.find((entry) => entry.handles.has(normalizedHandle));
      if (existing) {
        existing.ts = nowMs;
      } else {
        entries.push({ ts: nowMs, handles: new Set([normalizedHandle]) });
      }
      seen.set(key, entries);
      const accounts = new Set(entries.flatMap((entry) => [...entry.handles])).size;
      return { hit: accounts >= minAccountsCurrent, key, accounts };
    },
    /** 设置页改了窗口/账号数时热更新。 */
    configure(next = {}) {
      if (Number.isFinite(next.windowMs) && next.windowMs > 0) windowMsCurrent = next.windowMs;
      if (Number.isFinite(next.minAccounts) && next.minAccounts > 0) minAccountsCurrent = next.minAccounts;
    },
    /** 测试用。 */
    size() {
      return seen.size;
    },
    clear() {
      seen.clear();
    },
  };
}
