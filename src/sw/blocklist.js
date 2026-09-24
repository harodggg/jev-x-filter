/**
 * 黑名单（账号级）与白名单的纯逻辑：规范化、去重合并、导入导出。
 *
 * 存储格式对用户可见，因此设计成「人可读、可手改、可跨设备复制」：
 * {
 *   "schema": "jevx.blocklist",
 *   "version": 1,
 *   "entries": [ { "handle": "spammer", "firstSeen": 1726..., "lastSeen": ..., "hits": 3,
 *                  "bestBand": "block", "bestAdult": 0.98, "bestCategory": "adult_porn",
 *                  "reasons": [...], "source": "auto|manual|import", "tweetIds": [...] } ],
 *   "whitelist": { "handles": [], "keywords": [] }
 * }
 */

export const BLOCKLIST_SCHEMA = 'jevx.blocklist';
export const BLOCKLIST_VERSION = 1;

export function normalizeHandle(input) {
  const raw = String(input ?? '').trim().replace(/^@+/, '').replace(/\/+$/, '');
  // 允许直接粘贴个人主页地址（带或不带协议）
  const handle = raw
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\//i, '')
    .split(/[/?#]/)[0];
  return handle.toLowerCase();
}

export function isValidHandle(handle) {
  return /^[a-z0-9_]{1,15}$/.test(handle);
}

export function emptyBlocklist() {
  return { schema: BLOCKLIST_SCHEMA, version: BLOCKLIST_VERSION, updatedAt: 0, entries: [], whitelist: { handles: [], keywords: [] } };
}

export function makeEntry({
  handle,
  band,
  bestBand,
  reasons = [],
  category,
  bestCategory,
  adult,
  bestAdult,
  categoryConfidence,
  bestConfidence,
  source = 'auto',
  tweetId,
  tweetIds,
  hits,
  firstSeen,
  lastSeen,
  ts = Date.now(),
} = {}) {
  const normalized = normalizeHandle(handle);
  const resolvedBand = band ?? bestBand ?? 'hide';
  const resolvedAdult = typeof bestAdult === 'number' ? bestAdult : typeof adult === 'number' ? adult : null;
  const resolvedConfidence =
    typeof bestConfidence === 'number' ? bestConfidence : typeof categoryConfidence === 'number' ? categoryConfidence : null;
  const ids = Array.isArray(tweetIds) ? tweetIds.map(String) : tweetId ? [String(tweetId)] : [];
  return {
    handle: normalized,
    firstSeen: typeof firstSeen === 'number' ? firstSeen : ts,
    lastSeen: typeof lastSeen === 'number' ? lastSeen : ts,
    hits: typeof hits === 'number' && hits > 0 ? hits : 1,
    bestBand: resolvedBand,
    bestAdult: resolvedAdult,
    bestCategory: bestCategory ?? category ?? null,
    bestConfidence: resolvedConfidence,
    reasons: [...new Set(reasons)].slice(0, 8),
    source,
    tweetIds: ids.slice(-10),
  };
}

const BAND_ORDER = { ignore: 0, review: 1, hide: 2, block: 3 };

/** 合并：同一账号保留更严重的一档、更高的置信度，并累计命中次数。 */
export function mergeEntries(list, incoming) {
  const out = list?.entries ? structuredCloneSafe(list) : emptyBlocklist();
  const byHandle = new Map(out.entries.map((e) => [e.handle, e]));
  let added = 0;
  let updated = 0;

  for (const raw of incoming ?? []) {
    const handle = normalizeHandle(raw?.handle ?? raw);
    if (!isValidHandle(handle)) continue;
    const existing = byHandle.get(handle);
    if (!existing) {
      const entry = makeEntry({ ...raw, handle });
      out.entries.push(entry);
      byHandle.set(handle, entry);
      added++;
      continue;
    }
    updated++;
    existing.hits += raw?.hits && raw.hits > 0 ? raw.hits : 1;
    existing.firstSeen = Math.min(existing.firstSeen || Infinity, raw?.firstSeen ?? raw?.ts ?? Date.now());
    existing.lastSeen = Math.max(existing.lastSeen || 0, raw?.lastSeen ?? raw?.ts ?? Date.now());
    if ((BAND_ORDER[raw?.band ?? raw?.bestBand] ?? 0) > (BAND_ORDER[existing.bestBand] ?? 0)) {
      existing.bestBand = raw?.band ?? raw?.bestBand;
    }
    const adult = raw?.adult ?? raw?.bestAdult;
    if (typeof adult === 'number' && (existing.bestAdult === null || adult > existing.bestAdult)) existing.bestAdult = adult;
    const conf = raw?.categoryConfidence ?? raw?.bestConfidence;
    if (typeof conf === 'number' && (existing.bestConfidence === null || conf > existing.bestConfidence)) existing.bestConfidence = conf;
    if (raw?.category ?? raw?.bestCategory) existing.bestCategory = raw.category ?? raw.bestCategory;
    for (const reason of raw?.reasons ?? []) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    existing.reasons = existing.reasons.slice(0, 8);
    for (const id of raw?.tweetIds ?? []) {
      const s = String(id);
      if (!existing.tweetIds.includes(s)) existing.tweetIds.push(s);
    }
    existing.tweetIds = existing.tweetIds.slice(-10);
  }

  out.updatedAt = Date.now();
  out.entries.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return { list: out, added, updated };
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function hasHandle(list, handle) {
  const h = normalizeHandle(handle);
  return Boolean(list?.entries?.some((e) => e.handle === h));
}

export function removeHandle(list, handle) {
  const out = structuredCloneSafe(list?.entries ? list : emptyBlocklist());
  const h = normalizeHandle(handle);
  out.entries = out.entries.filter((e) => e.handle !== h);
  out.updatedAt = Date.now();
  return out;
}

export function toExport(list) {
  const out = structuredCloneSafe(list?.entries ? list : emptyBlocklist());
  out.exportedAt = new Date().toISOString();
  return JSON.stringify(out, null, 2);
}

/**
 * 宽容解析导入内容，支持四种写法：
 *   1. 本扩展自己的 schema 对象；
 *   2. `{ "handles": ["@a", { "handle": "b", "reason": "..." }] }`
 *   3. 纯数组：`["@a", "b"]`
 *   4. 纯文本：每行一个账号（允许 `@x`、`x.com/x`、逗号分隔）
 */
export function parseImport(text) {
  const result = { ok: false, entries: [], whitelist: { handles: [], keywords: [] }, errors: [], format: 'unknown' };
  const raw = String(text ?? '').trim();
  if (!raw) {
    result.errors.push('empty_input');
    return result;
  }

  const pushHandle = (value, extra = {}) => {
    const handle = normalizeHandle(typeof value === 'string' ? value : value?.handle);
    if (!isValidHandle(handle)) {
      result.errors.push(`invalid_handle:${String(typeof value === 'string' ? value : value?.handle).slice(0, 24)}`);
      return;
    }
    result.entries.push({ ...extra, handle });
  };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.schema === BLOCKLIST_SCHEMA && Array.isArray(parsed.entries)) {
      result.format = 'jevx.blocklist';
      for (const e of parsed.entries) pushHandle(e, { ...e, source: e?.source ?? 'import' });
      result.whitelist = {
        handles: (parsed.whitelist?.handles ?? []).map(normalizeHandle).filter(isValidHandle),
        keywords: (parsed.whitelist?.keywords ?? []).map((k) => String(k)).filter(Boolean),
      };
    } else if (Array.isArray(parsed.handles)) {
      result.format = 'handles';
      for (const h of parsed.handles) pushHandle(h, { source: 'import' });
      result.whitelist = {
        handles: (parsed.whitelist?.handles ?? []).map(normalizeHandle).filter(isValidHandle),
        keywords: (parsed.whitelist?.keywords ?? []).map((k) => String(k)).filter(Boolean),
      };
    } else {
      result.format = 'object';
      for (const [handle, meta] of Object.entries(parsed)) pushHandle(handle, { ...(typeof meta === 'object' ? meta : {}), source: 'import' });
    }
    // 允许「只有白名单、没有黑名单」的导入（例如只想同步放行名单）。
    result.ok =
      result.entries.length > 0 || result.whitelist.handles.length > 0 || result.whitelist.keywords.length > 0;
    return result;
  }

  if (Array.isArray(parsed)) {
    result.format = 'array';
    for (const item of parsed) pushHandle(item, { source: 'import' });
    result.ok = result.entries.length > 0;
    return result;
  }

  result.format = 'lines';
  for (const line of raw.split(/[\n,;]+/)) {
    const cell = line.trim();
    if (!cell || cell.startsWith('#')) continue;
    pushHandle(cell.split(/\s+/)[0], { source: 'import' });
  }
  result.ok = result.entries.length > 0;
  return result;
}

/** 导入并合并（去重、保留既有记录）。 */
export function importInto(list, text) {
  const parsed = parseImport(text);
  if (!parsed.ok) return { ...parsed, list: list?.entries ? list : emptyBlocklist(), added: 0, updated: 0 };
  const merged = mergeEntries(list, parsed.entries);
  const whitelistHandles = new Set([...(merged.list.whitelist?.handles ?? []), ...parsed.whitelist.handles]);
  const whitelistKeywords = new Set([...(merged.list.whitelist?.keywords ?? []), ...parsed.whitelist.keywords]);
  merged.list.whitelist = { handles: [...whitelistHandles], keywords: [...whitelistKeywords] };
  return { ...parsed, list: merged.list, added: merged.added, updated: merged.updated };
}

export function listStats(list) {
  const entries = list?.entries ?? [];
  const bySource = {};
  for (const e of entries) bySource[e.source ?? 'unknown'] = (bySource[e.source ?? 'unknown'] ?? 0) + 1;
  return {
    total: entries.length,
    bySource,
    lastUpdated: list?.updatedAt ?? 0,
    whitelistHandles: list?.whitelist?.handles?.length ?? 0,
    whitelistKeywords: list?.whitelist?.keywords?.length ?? 0,
  };
}
