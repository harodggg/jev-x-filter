/**
 * 文案农场检测（重复刷屏）—— 又一条「不靠词表」的信号。
 *
 * 真站形态：同一段无实质内容的话被多个随机账号在短时间内刷出来（回复区里 4 个账号同一句）。
 * 单看任意一条，连模型都只能说「不确定」；但「同一段话被多个账号短时间复制」本身就是农场证据。
 *
 * v0.3.1 起用**近似去重**而不是精确相等 —— 这是被真站样本逼出来的：
 * 农场账号会在同一句里各插不同垃圾字符（`比我好看的没我骚蝎🐾…` / `…没我骚🐾💩…`、
 * `应该没人比我玩的开了吧…` / `没人比我玩的开了吧…`），精确匹配永远聚不成类。
 * 现在按**字符 3-gram 的 Jaccard 相似度**聚类（默认 ≥0.8），
 * 并把「同一条推文里重复同一句」也当成结构信号（`hasRepeatedLine`）。
 *
 * 设计要点：
 * - 归一到「只留 CJK 与字母数字」，并折叠重复行 —— 换 emoji、换标点、改大小写、复制两遍都躲不掉；
 * - 只统计**不同账号**（同一账号重复不算农场）；
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

/** 近似判定的默认相似度阈值（字符 3-gram 的 Jaccard）。 */
export const FARM_MIN_SIMILARITY = 0.8;

/** 把「同一句话重复写 N 遍」折叠成一遍（真站样本：同一条推文里写了两遍）。 */
export function collapseRepeatedLines(raw) {
  const lines = String(raw ?? '')
    .split(/[\n\r。！？!?；;]+/)
    .map((line) => normalizeFarmText(line))
    .filter(Boolean);
  const seen = new Set();
  const kept = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    kept.push(line);
  }
  return kept.join('');
}

/**
 * 归一化后的农场键：折叠重复行、并确保长度达标。
 * @returns {string|null}
 */
export function farmKey(text) {
  const normalized = collapseRepeatedLines(text);
  if (normalized.length < FARM_MIN_CHARS) return null;
  return normalized;
}

/** 同一段文本里是否重复了同一条（≥8 个有效字符）句子 —— 刷屏特征。 */
export function hasRepeatedLine(text) {
  const lines = String(text ?? '')
    .split(/[\n\r。！？!?；;]+/)
    .map((line) => normalizeFarmText(line))
    .filter((line) => line.length >= 8);
  return new Set(lines).size < lines.length;
}

/** 字符 n-gram 集合（默认 3-gram），用于近似比较。 */
export function shingles(text, n = 3) {
  const s = String(text ?? '');
  const set = new Set();
  if (s.length < n) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  return set;
}

/**
 * 两段（已归一化的）文本的相似度，0..1。
 *
 * 用 **3-gram 的重叠系数**（交集 / 较短的 n-gram 集合大小），而不是 Jaccard —— 实测对比：
 * 插一个垃圾字符的近似重复（`…没我骚蝎…` vs `…没我骚…`）Jaccard 只有 0.67，
 * 会把农场拆散；重叠系数给出 0.83，而完全无关的两段文案是 0.00，分离度足够。
 * 另加长度比护栏（0.5–2.0），避免一行短句被一段长文「包含」而误聚。
 */
export function farmSimilarity(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa && !sb) return 1;
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const ratio = Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
  if (ratio < 0.5) return 0;
  const setA = shingles(sa);
  const setB = shingles(sb);
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = smaller === setA ? setB : setA;
  if (smaller.size === 0) return 0;
  let inter = 0;
  for (const g of smaller) if (larger.has(g)) inter += 1;
  return inter / smaller.size;
}

export function createFarmTracker(options = {}) {
  const {
    windowMs = options.windowMs ?? 1800000, // 30 分钟
    minAccounts = options.minAccounts ?? 2,
    minSimilarity = options.minSimilarity ?? FARM_MIN_SIMILARITY,
    maxClusters = options.maxClusters ?? 300,
    now = () => Date.now(),
  } = options;
  let windowMsCurrent = windowMs;
  let minAccountsCurrent = minAccounts;
  let minSimilarityCurrent = minSimilarity;

  /** @type {{key: string, handles: Set<string>, ts: number, samples: string[]}[]} */
  const clusters = [];

  function evict(nowMs) {
    const cutoff = nowMs - windowMsCurrent;
    for (let i = clusters.length - 1; i >= 0; i--) {
      if (clusters[i].ts <= cutoff) clusters.splice(i, 1);
    }
    while (clusters.length > maxClusters) clusters.shift();
  }

  return {
    /**
     * 记一条推文，返回农场判定。
     * @returns {{hit: boolean, key: string|null, accounts: number, similarity: number, samples: string[]}}
     */
    record(text, handle, options2 = {}) {
      const key = farmKey(text);
      if (!key) return { hit: false, key: null, accounts: 0, similarity: 0, samples: [] };
      const nowMs = options2.nowMs ?? now();
      evict(nowMs);

      let cluster = null;
      let best = 0;
      for (const candidate of clusters) {
        const sim = farmSimilarity(key, candidate.key);
        if (sim > best) best = sim;
        if (sim >= minSimilarityCurrent) {
          cluster = candidate;
          break;
        }
      }
      if (!cluster) {
        cluster = { key, handles: new Set(), ts: nowMs, samples: [] };
        clusters.push(cluster);
      }
      const normalizedHandle = String(handle ?? '').replace(/^@+/, '').toLowerCase() || `#anon:${clusters.length}`;
      cluster.handles.add(normalizedHandle);
      cluster.ts = nowMs;
      if (!cluster.samples.includes(key) && cluster.samples.length < 3) cluster.samples.push(key);

      const accounts = cluster.handles.size;
      return {
        hit: accounts >= minAccountsCurrent,
        key: cluster.key,
        accounts,
        similarity: cluster.key === key ? 1 : Number(best.toFixed(3)),
        samples: cluster.samples.slice(),
      };
    },
    /** 设置页改了窗口/账号数/相似度时热更新。 */
    configure(next = {}) {
      if (Number.isFinite(next.windowMs) && next.windowMs > 0) windowMsCurrent = next.windowMs;
      if (Number.isFinite(next.minAccounts) && next.minAccounts > 0) minAccountsCurrent = next.minAccounts;
      if (Number.isFinite(next.minSimilarity) && next.minSimilarity > 0 && next.minSimilarity <= 1) {
        minSimilarityCurrent = next.minSimilarity;
      }
    },
    /** 序列化（Service Worker 会被空闲回收，运行态要能恢复）。 */
    serialize() {
      return {
        savedAt: now(),
        clusters: clusters.map((c) => ({
          key: c.key,
          ts: c.ts,
          handles: [...c.handles],
          samples: c.samples.slice(),
        })),
      };
    },
    /** 从序列化数据恢复（跨 Service Worker 重启保留农场簇）。 */
    restore(data) {
      clusters.length = 0;
      const saved = data && Array.isArray(data.clusters) ? data.clusters : [];
      for (const c of saved) {
        if (!c || typeof c.key !== 'string') continue;
        clusters.push({
          key: c.key,
          ts: Number.isFinite(c.ts) ? c.ts : now(),
          handles: new Set(Array.isArray(c.handles) ? c.handles.map((h) => String(h)) : []),
          samples: Array.isArray(c.samples) ? c.samples.slice(0, 3) : [c.key],
        });
      }
      evict(now());
      return clusters.length;
    },
    /** 测试用。 */
    size() {
      return clusters.length;
    },
    clear() {
      clusters.length = 0;
    },
  };
}
