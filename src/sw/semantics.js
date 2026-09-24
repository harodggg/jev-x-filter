/**
 * α / β 语义层：重复信息折叠（β）与特殊观点标记（α）。
 *
 * 过滤器本体只回答「要不要隐藏 / 要不要动账号」，但时间线上还有两类**信息组织**问题：
 *   · β（重复 / 类似 / 同一主张）：同一条信息被转述、翻译、改写后刷了很多遍，用户只想看一遍；
 *   · α（特殊信息）：回复区里与多数观点明显不同的那条，用户不想漏掉，但也不该被隐藏。
 * 这两件事都**只作为展示载荷**附加到决策上，绝不改变 `band` / `accountAction`
 * —— 这是本项目最硬的不变量 I1。
 *
 * 成本控制：候选先在本地筛（归一化文本的 3-gram 重叠系数 ≥0.45；同 threadId 需 ≥0.30；同农场簇），
 * 命中才发**一次** Jev 调用，把「每个候选一个 noul」与「α 的一个 noul + 一个 score」放进同一次请求。
 * 没有候选时一次调用都不发（省额度，也让「相似才送模型」可被断言）。
 *
 * 时机（Lead 定的取舍，有意为之）：语义调用在 pipeline 的过滤判定**之后**、但在 `decide()`
 * 返回**之前** await —— `beta` / `alpha` 必须随决策一起返回（冻结载荷），
 * 所以**每条有候选的推文会比纯过滤多等一次模型调用**（一次串行网络往返，长尾可能到秒级）。
 * 换来的是不需要新增 SW→内容脚本的第二条消息类型与页面侧二次渲染路径。
 * 若将来要削掉这段延迟，就必须把语义层改成「先返回决策、再异步补发语义载荷」，
 * 那时要同步加消息类型与 UI 二次渲染 —— 本轮明确不做。
 * 相关预算口径：语义调用同时占用语义自己的 `maxPerMinute/maxPerDay`、全局
 * `budget.maxJevPerMinute/maxJevPerDay`（并给过滤留 `reserveForFiltering` 保底），
 * 也计入 `stats.jevCalls`（细分计在 `stats.semantics.calls`）。
 *
 * 冻结接口（Lead 定，UI / 端到端按它写，不要改）：
 *   · β 问题 id：`beta_c1` … `beta_cN`（noul）；α：`alpha_majority`（noul）+ `alpha_contrast`（score，4 级）；
 *   · state 三段固定顺序：CANDIDATE / CANDIDATE_META / REFERENCES，没有参考时 `REFERENCES:` 后写 `(none)`；
 *   · decision.beta = { duplicateOf, groupKey, groupSize, similarity, kind, folded }；
 *   · decision.alpha = { hit, score, reason, referenceCount, summary }。
 *
 * 口径（实现细节，写在这里便于复核）：
 *   · β 折叠：组内 max(beta_cN 的 noul) ≥ `beta.threshold`；`kind` 用本地文本判定
 *     （verbatim=归一化后完全一致 / paraphrase=本地 3-gram ≥0.6 / 其余 same_claim），
 *     模型若返回合法 choice 则以 choice 为准；`similarity` 记录的是**模型 noul**（语义相似度）；
 *     `duplicateOf` = 组内最早出现的那条（窗口内顺序），`groupSize` = 组内条数（含自己）。
 *   · β 折叠场景开关：`context === 'reply'` 看 `foldInReplies`，其余（timeline / recommended）看 `foldInFeed`；
 *     对应开关关掉时**不发 β 问题**，beta 直接返回 null（α 不受这两个开关影响）。
 *   · α 命中：`alpha_majority ≥ alpha.threshold` **且** 本地与多数参考的相似度 ≤0.5
 *     （用「与各参考相似度的中位数」代表「与多数参考的相似度」，避免把跟着多数说的标成 α）；
 *     `alpha.score` = `alpha_contrast` 的 4 级分数归一化到 0..1。
 *   · 答案解析：缺字段一律 null（不猜）；模型抛错由调用方计数，本模块不吞异常。
 */
import { noul, score } from '../vendor/jev-systemone/dist/index.js';
import { normalizeFarmText, shingles } from './farm.js';
import { hash32, truncate } from './util.js';

/** β 的三种形态（冻结取值）。 */
export const SEMANTICS_KIND = Object.freeze({
  verbatim: 'verbatim',
  paraphrase: 'paraphrase',
  same_claim: 'same_claim',
});

/** 本地候选筛选阈值：归一化文本的 3-gram 重叠系数。 */
export const CANDIDATE_MIN_SIMILARITY = 0.45;
/**
 * 同 threadId 候选的**更低**门槛（0.30）。
 *
 * 三档门槛的理由：同一条推文下的回复本来就共享上下文（同一个话题、同一批词），
 * 「同一信息」的概率天然比陌生推文高，所以可以放宽到 0.30；
 * 但也不能无条件入选 —— 同一条热门推文下有大量**无关回复**，
 * 全送模型既费钱又容易把「恰好都在同一楼」误判成同一主张。
 * 陌生的相似推文仍要求 0.45；同农场簇（结构信号，见 farm.js）不需要相似度下限。
 */
export const SAME_THREAD_MIN_SIMILARITY = 0.3;
/** 本地「转述」阈值：相似度够高就是 paraphrase，否则算 same_claim。 */
export const PARAPHRASE_MIN_SIMILARITY = 0.6;
/** α 护栏：与多数参考的相似度高于该值 = 在跟着多数说，不标 α。 */
export const ALPHA_MAJORITY_MAX_SIMILARITY = 0.5;
/** α 差异程度用 4 级 score（0..3），归一化到 0..1。 */
export const ALPHA_SCORE_LEVELS = 4;
export const ALPHA_REASON = 'diverges_from_majority';
/** UI 直接显示的中文短句（冻结文案）。 */
export const ALPHA_SUMMARY = '与评论区多数观点不同';
export const BETA_QUESTION_PREFIX = 'beta_c';
export const ALPHA_MAJORITY_ID = 'alpha_majority';
export const ALPHA_CONTRAST_ID = 'alpha_contrast';
/** state 上限，避免超长推文把上下文塞满。 */
export const SEMANTICS_STATE_LIMIT = 4000;
/** 单条参考文本显示上限。 */
const REFERENCE_TEXT_LIMIT = 400;

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 只接受真实数字，其余（含字符串）一律当作「缺字段」。 */
function finite01OrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clamp01(value);
}

function round3(n) {
  return Number(n.toFixed(3));
}

/** 推文 threadId 归一化：空串 / undefined → null。 */
export function threadIdOf(tweet) {
  const raw = tweet?.threadId;
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

function handleOf(tweet) {
  return String(tweet?.handle ?? '').replace(/^@+/, '') || 'unknown';
}

function displayNameOf(tweet) {
  const name = String(tweet?.displayName ?? '').trim();
  return name || '(none)';
}

function positionOf(tweet) {
  return String(tweet?.context ?? 'timeline') || 'timeline';
}

/** 参考文本压成一行（模型读的是文本，不是格式）。 */
function oneLine(text) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), REFERENCE_TEXT_LIMIT) || '(empty)';
}

/** 归一化文本：只留 CJK / 假名 / 字母数字（与农场检测同一套，转述时大小写、标点、emoji 都躲不掉）。 */
export function normalizeSemanticText(text) {
  return normalizeFarmText(text);
}

/**
 * 两段文本的相似度（0..1）：归一化后的**字符 3-gram 重叠系数**（交集 / 较小集合大小）。
 *
 * 说明：这里刻意不加长度比护栏 —— 语义层的候选只决定「要不要问模型」，
 * 问多了只是多一个廉价 noul，不会直接改变判定；宁可放过也不要在本地误判「不像」。
 */
export function semanticSimilarity(a, b) {
  const sa = normalizeSemanticText(a);
  const sb = normalizeSemanticText(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const setA = shingles(sa);
  const setB = shingles(sb);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / small.size;
}

/** 中位数（空数组 → 0）：用来代表「与多数参考的相似度」。 */
export function median(values) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 候选 / 参考的唯一键（有 id 用 id，没有就用 handle+文本哈希）。 */
function entryKey(item) {
  if (item?.id !== undefined && item?.id !== null && item.id !== '') return `id:${item.id}`;
  return `h:${hash32(`${item?.handle ?? ''}|${item?.text ?? ''}`)}`;
}

/** 场景开关：reply 看 foldInReplies，其余（timeline / recommended / 未知）看 foldInFeed。 */
export function foldAllowed(context, betaCfg = {}) {
  const position = String(context ?? 'timeline');
  if (position === 'reply') return betaCfg.foldInReplies !== false;
  return betaCfg.foldInFeed !== false;
}

/* ------------------------------- 最近推文窗口 ------------------------------- */

/**
 * 把一条推文规范成窗口条目（无效条目返回 null）。
 *
 * 条目身份（`id`）：真实推文 id 优先；拿不到 id 时退化成「作者 + 文案」的稳定哈希 `h:<hash32>`。
 *
 * 为什么必须有这个兜底：内容脚本的 `getTweetId()` 只在状态链接里匹配
 * `/status/<5..25 位数字>`，短 id 或没有状态链接时返回 null。窗口条目一旦没有身份，
 * `pickBetaCandidates` 会把它整条跳过（β 需要一个可折叠的锚点），
 * 于是**同一页里语义相同的两条推文一个候选都选不出来** —— β 在真站端到端里一次都不触发
 * （端到端夹具的推文 id 是 4 位数 `1101/1102`，正好踩中；α 靠 threadId 不需要 id，所以照常工作）。
 * 哈希身份是内容稳定的：同一段文案再次进入窗口会被识别成同一条并刷新，而不是又加一条。
 */
function normalizeRecentEntry(tweet, seq, nowMs) {
  const text = String(tweet?.text ?? '');
  const handle = handleOf(tweet);
  const rawId = tweet?.id === undefined || tweet?.id === null || tweet?.id === '' ? null : String(tweet.id);
  if (!text.trim() && !rawId) return null;
  const id = rawId ?? `h:${hash32(`${handle}|${text}`)}`;
  return {
    id,
    text,
    handle,
    displayName: String(tweet?.displayName ?? ''),
    threadId: threadIdOf(tweet),
    context: positionOf(tweet),
    farmKey: tweet?.farmKey === undefined || tweet?.farmKey === null ? null : String(tweet.farmKey),
    /** 判定档位：入窗时为 null（尚未判定），判定完成后由 pipeline 回填。 */
    band: null,
    seq,
    ts: nowMs,
  };
}

/**
 * 最近推文滚动窗口（默认最近 `windowSize` 条）。
 *
 * Service Worker 空闲回收会丢掉它 —— 这是可接受的：农场簇另有 runtime 持久化，
 * 语义窗口只是「最近看到过什么」，丢了下一次重新积累即可（也和 triage 的分钟窗口同策略）。
 *
 * 口径（重要）：窗口记的是**观察到的推文**，不是「已完成判定的推文」。
 * pipeline 在 `runDecide` 最前面（任何 await 之前）就把推文 push 进来，
 * 这样同一页里**并发**判定的多篇文章才能互相看到 —— 否则后一条永远看不见前一条，
 * β / α 在真实时间线上会大面积失效（真实 Chrome 端到端抓到的缺陷）。
 * 被 prefilter 跳过的推文同样会进窗口；它们的 `band` 回填为 `ignore`（本来也是放行）。
 */
export function createRecentWindow({ maxSize = 60, now = () => Date.now() } = {}) {
  let limit = Number.isFinite(maxSize) && maxSize >= 0 ? Math.trunc(maxSize) : 60;
  let seq = 0;
  const items = [];

  function trim() {
    while (items.length > limit) items.shift();
  }

  return {
    /** 设置页改了 windowSize 时热更新（会立刻裁掉超出部分）。 */
    configure({ maxSize: next } = {}) {
      if (Number.isFinite(next) && next >= 0) {
        limit = Math.trunc(next);
        trim();
      }
      return limit;
    },
    /** 记一条推文并返回条目（调用方可回填 band / farmKey）；同 id 再次出现时刷新到「最近」。 */
    push(tweet) {
      const entry = normalizeRecentEntry(tweet, ++seq, now());
      if (!entry) return null;
      if (entry.id) {
        const at = items.findIndex((x) => x.id === entry.id);
        if (at >= 0) items.splice(at, 1);
      }
      items.push(entry);
      trim();
      return entry;
    },
    /** 快照（旧 → 新）。 */
    list() {
      return items.slice();
    },
    size() {
      return items.length;
    },
    clear() {
      items.length = 0;
    },
  };
}

/* ------------------------------- 本地候选筛选 ------------------------------- */

/**
 * β 候选：最近窗口里与当前推文「像」的那些（≤ maxCandidates）。
 *
 * 命中任一条件即算候选：
 *   · 归一化文本的 3-gram 重叠系数 ≥ 0.45（陌生推文）；
 *   · 同一个非空 threadId **且** 本地相似度 ≥ 0.30（同一条推文下的回复，见 SAME_THREAD_MIN_SIMILARITY）；
 *   · 同一个农场簇（farmKey 相同，结构信号不需要相似度下限）。
 * 自己（同 id）永远排除 —— 同一条推文重新进入视口不是「重复信息」。
 * 窗口条目的 id 一定有值：真实推文 id，或缺 id 时的「作者 + 文案」稳定哈希
 * （见 `normalizeRecentEntry`；没有它 β 在拿不到 id 的页面上会整体失效）。
 *
 * `selfSeq` 是当前推文在窗口里的序号（由 pipeline 传入）：只把**比自己更早进入窗口**的推文
 * 当候选。这样在并发判定时「先出现的那条」不会反过来折叠到后出现的条上（否则同一个组会被
 * 折没两条），也保证 `duplicateOf` 一定早于自己。
 *
 * 排序：先按本地相似度取前 maxCandidates 条，再按窗口内出现顺序（旧 → 新）返回，
 * 这样 `duplicateOf` 一定落在组内最早出现的那条上。
 */
export function pickBetaCandidates(target, recent, settings, selfSeq = Number.POSITIVE_INFINITY) {
  const betaCfg = settings?.semantics?.beta ?? {};
  const max = Number.isFinite(betaCfg.maxCandidates) ? Math.max(0, Math.trunc(betaCfg.maxCandidates)) : 6;
  if (max <= 0) return [];
  const targetId = target?.id === undefined || target?.id === null || target?.id === '' ? null : String(target.id);
  const targetThread = threadIdOf(target);
  const targetFarm = target?.farmKey === undefined || target?.farmKey === null ? null : String(target.farmKey);

  const qualifying = [];
  for (const item of recent ?? []) {
    if (!item || !item.id) continue;
    if (item.seq >= selfSeq) continue; // 自己以及「比自己更晚进入窗口」的推文都不是折叠目标
    if (targetId && item.id === targetId) continue;
    const localSimilarity = semanticSimilarity(target?.text, item.text);
    const sameThread = Boolean(targetThread) && item.threadId === targetThread;
    const sameFarm = Boolean(targetFarm) && Boolean(item.farmKey) && item.farmKey === targetFarm;
    const qualified =
      localSimilarity >= CANDIDATE_MIN_SIMILARITY ||
      (sameThread && localSimilarity >= SAME_THREAD_MIN_SIMILARITY) ||
      sameFarm;
    if (!qualified) continue;
    qualifying.push({
      id: String(item.id),
      text: String(item.text ?? ''),
      handle: item.handle ?? '',
      displayName: item.displayName ?? '',
      threadId: item.threadId ?? null,
      seq: item.seq ?? 0,
      ts: item.ts ?? 0,
      localSimilarity,
      sameThread,
      sameFarm,
    });
  }

  qualifying.sort((a, b) => b.localSimilarity - a.localSimilarity || a.seq - b.seq);
  const picked = qualifying.slice(0, max);
  picked.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  return picked;
}

/**
 * α 参考：同一条推文（同 threadId）下**观察到**的回复，最多 maxReferences 条。
 * 只提供上下文，不单独触发调用；没有 threadId 时返回空数组。
 *
 * 两条口径：
 *   · 「先观察、后判定」：不要求参考比自己早进入窗口 —— 同一页里并发的回复互相都该算参考，
 *     否则 α 在真实时间线上会失效（后一条永远看不到前一条）。
 *   · 产品护栏（§7.2）：**已判定为非 ignore（hide / block / review）的条目不作为参考** ——
 *     被隐藏的垃圾评论不该被当成「评论区多数观点」。
 *     注意：`band` 未知（还在并发判定中、尚未回填）的条目**保留**，
 *     否则并发场景下参考集合会永远是空的，「先观察、后判定」就白做了。
 */
export function pickAlphaReferences(target, recent, settings, selfSeq = Number.POSITIVE_INFINITY) {
  const alphaCfg = settings?.semantics?.alpha ?? {};
  const max = Number.isFinite(alphaCfg.maxReferences) ? Math.max(0, Math.trunc(alphaCfg.maxReferences)) : 12;
  const thread = threadIdOf(target);
  if (!thread || max <= 0) return [];
  const targetId = target?.id === undefined || target?.id === null || target?.id === '' ? null : String(target.id);
  const refs = [];
  for (const item of recent ?? []) {
    if (!item || !item.threadId || item.threadId !== thread) continue;
    if (item.seq === selfSeq) continue;
    if (targetId && item.id && item.id === targetId) continue;
    if (item.band && item.band !== 'ignore') continue;
    refs.push({
      id: item.id ?? null,
      text: String(item.text ?? ''),
      handle: item.handle ?? '',
      threadId: item.threadId,
      seq: item.seq ?? 0,
      ts: item.ts ?? 0,
    });
  }
  refs.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  return refs.slice(-max);
}

/** α 是否该问：enabled + onlyInReplies 场景 + threadId 非空 + 参考数 ≥ minReferences。 */
export function alphaApplicable(target, references, settings) {
  const alphaCfg = settings?.semantics?.alpha;
  if (!alphaCfg || alphaCfg.enabled === false) return { applicable: false, reason: 'alpha_disabled' };
  if (alphaCfg.onlyInReplies !== false && target?.context !== 'reply') {
    return { applicable: false, reason: 'not_reply' };
  }
  if (!threadIdOf(target)) return { applicable: false, reason: 'no_thread' };
  const min = Number.isFinite(alphaCfg.minReferences) ? Math.max(0, Math.trunc(alphaCfg.minReferences)) : 3;
  if ((references?.length ?? 0) < min) return { applicable: false, reason: 'not_enough_references' };
  return { applicable: true, reason: null };
}

/* ------------------------------- 一次调用的构造 ------------------------------- */

function betaInstructions(index) {
  return (
    `Reference [${index}] and the CANDIDATE (the post above) carry the same information or the same claim. ` +
    'A paraphrase, a translation, a rewrite, or the same opinion expressed in different words still counts as the same. ' +
    'Different topics, different claims, or merely posting in the same thread do NOT count.'
  );
}

function alphaMajorityInstructions() {
  return (
    'The CANDIDATE (the post above) expresses a view that clearly diverges from the majority opinion of the reference comments ' +
    'listed in REFERENCES. The CANDIDATE must be a substantive opinion — an argument, a correction, a fact or a dissent — ' +
    'not spam, noise, a joke, an advertisement or an off-topic remark. ' +
    'If the CANDIDATE broadly agrees with most of the references, answer no.'
  );
}

const ALPHA_CONTRAST_CRITERIA = [
  'No divergence: agrees with the majority, or the references carry no clear opinion',
  'Slight divergence: only a detail or a nuance differs',
  'Clear divergence: a different conclusion on the same topic',
  'Strong divergence: an opposite or dissenting view stated as substantive content',
];

const BETA_CRITERIA = {
  true: 'reference and candidate express the same information or the same claim',
  false: 'different information, different claim, or unrelated',
};

/**
 * 拼 state + questions（纯函数，不发请求）。
 *
 * REFERENCES 顺序：β 候选在前（`[1]..[N]`，与 `beta_c1..cN` 一一对应），
 * 然后是仅作为 α 上下文、不参与 β 的问题的同 thread 参考。
 */
export function buildSemanticsRequest({ target, candidates = [], references = [], alpha = false }) {
  const used = [];
  const index = new Map();
  const add = (item) => {
    const key = entryKey(item);
    if (index.has(key)) return;
    index.set(key, used.length + 1);
    used.push(item);
  };
  for (const candidate of candidates) add(candidate);
  for (const reference of references) add(reference);

  const lines = [
    'CANDIDATE:',
    String(target?.text ?? '').trim() || '(no text)',
    '',
    'CANDIDATE_META:',
    `handle=@${handleOf(target)}; display_name=${displayNameOf(target)}; position=${positionOf(target)}; thread_id=${threadIdOf(target) ?? 'none'}`,
    '',
    'REFERENCES:',
  ];
  if (used.length === 0) lines.push('(none)');
  else used.forEach((item, i) => lines.push(`[${i + 1}] @${handleOf(item)}: ${oneLine(item.text)}`));

  const questions = {};
  candidates.forEach((candidate, i) => {
    const n = index.get(entryKey(candidate)) ?? i + 1;
    questions[`${BETA_QUESTION_PREFIX}${i + 1}`] = noul(betaInstructions(n), BETA_CRITERIA);
  });
  if (alpha) {
    questions[ALPHA_MAJORITY_ID] = noul(alphaMajorityInstructions(), {
      true: 'a substantive opinion that clearly differs from what most references say',
      false: 'agrees with most references, or is not a substantive opinion',
    });
    questions[ALPHA_CONTRAST_ID] = score(
      'How strongly does the CANDIDATE diverge from the majority opinion of the references? Rate the disagreement, not the writing quality.',
      ALPHA_CONTRAST_CRITERIA,
    );
  }

  return {
    state: truncate(lines.join('\n'), SEMANTICS_STATE_LIMIT),
    questions,
    referenceCount: references.length,
    candidateCount: candidates.length,
  };
}

/* ------------------------------- 调用计划 ------------------------------- */

/**
 * 组装本轮语义调用计划（纯函数）：本地筛选 + 场景开关 + 问题构造。
 *
 * 返回 `call: false` 时**不要发请求**；`reason` 说明原因（供统计与排查）：
 *   · semantics_disabled / beta_disabled / beta_fold_disabled / no_candidates / alpha_gate。
 *
 * `selfSeq`：当前推文在最近窗口里的序号。β 只把它当作「只折叠到更早出现的推文」的边界，
 * α 只用它排除自己。
 */
export function planSemanticCall({ target, recent, settings, selfSeq = Number.POSITIVE_INFINITY }) {
  const sem = settings?.semantics;
  const base = {
    call: false,
    reason: null,
    state: '',
    questions: {},
    candidates: [],
    references: [],
    referenceCount: 0,
    candidateCount: 0,
    betaAllowed: false,
    alphaApplicable: false,
  };
  if (!sem || sem.enabled === false) return { ...base, reason: 'semantics_disabled' };

  const betaCfg = sem.beta ?? {};
  const betaAllowed = betaCfg.enabled !== false && foldAllowed(target?.context, betaCfg);
  const references = pickAlphaReferences(target, recent, settings, selfSeq);
  const alphaGate = alphaApplicable(target, references, settings);
  const candidates = betaAllowed ? pickBetaCandidates(target, recent, settings, selfSeq) : [];

  const request = buildSemanticsRequest({ target, candidates, references, alpha: alphaGate.applicable });
  const plan = {
    ...base,
    ...request,
    candidates,
    references,
    betaAllowed,
    alphaApplicable: alphaGate.applicable,
  };
  if (Object.keys(request.questions).length === 0) {
    // 没有任何问题可问 → 一次调用都不发。reason 只用于排查，不影响判定。
    let reason = 'no_candidates';
    if (betaCfg.enabled === false) reason = 'beta_disabled';
    else if (!betaAllowed) reason = 'beta_fold_disabled';
    else if (candidates.length === 0) reason = 'no_candidates';
    else reason = alphaGate.reason ?? 'alpha_gate';
    return { ...plan, call: false, reason };
  }
  return { ...plan, call: true, reason: null };
}

/* ------------------------------- 答案解析 ------------------------------- */

function normalizeKind(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return SEMANTICS_KIND[key] ?? null;
}

function groupKeyFor(representative) {
  const normalized = normalizeSemanticText(representative?.text);
  return `bk_${hash32(normalized || String(representative?.id ?? ''))}`;
}

/** β 解析：缺字段不猜；组内 max(noul) ≥ 阈值才折叠。 */
function readBeta(answers, plan, target, betaCfg) {
  if (!plan.betaAllowed || plan.candidateCount === 0) return null;
  const threshold = Number.isFinite(betaCfg?.threshold) ? betaCfg.threshold : 0.7;
  const confirmed = [];
  plan.candidates.forEach((candidate, i) => {
    const answer = answers?.[`${BETA_QUESTION_PREFIX}${i + 1}`];
    const probability = finite01OrNull(answer?.noul);
    if (probability === null || probability < threshold) return;
    confirmed.push({ candidate, probability, choice: normalizeKind(answer?.choice) });
  });
  if (confirmed.length === 0) return null;

  const earliest = confirmed.reduce((best, current) =>
    (current.candidate.seq ?? 0) < (best.candidate.seq ?? 0) ? current : best,
  );
  const representative = earliest.candidate;
  const targetNormalized = normalizeSemanticText(target?.text);
  const repNormalized = normalizeSemanticText(representative?.text);
  const localSimilarity = semanticSimilarity(target?.text, representative?.text);
  const heuristicKind =
    targetNormalized && targetNormalized === repNormalized
      ? SEMANTICS_KIND.verbatim
      : localSimilarity >= PARAPHRASE_MIN_SIMILARITY
        ? SEMANTICS_KIND.paraphrase
        : SEMANTICS_KIND.same_claim;
  const similarity = Math.max(...confirmed.map((c) => c.probability));

  return {
    duplicateOf: String(representative.id),
    groupKey: groupKeyFor(representative),
    groupSize: confirmed.length + 1,
    similarity: round3(similarity),
    kind: earliest.choice ?? heuristicKind,
    folded: true,
  };
}

/** α 解析：缺字段不猜；命中 = majority 概率 ≥ 阈值 且 与多数参考的本地相似度 ≤0.5。 */
function readAlpha(answers, plan, target, alphaCfg) {
  if (!plan.alphaApplicable) return null;
  const probability = finite01OrNull(answers?.[ALPHA_MAJORITY_ID]?.noul);
  const rawScore = answers?.[ALPHA_CONTRAST_ID]?.score;
  if (probability === null || typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null;
  const threshold = Number.isFinite(alphaCfg?.threshold) ? alphaCfg.threshold : 0.7;
  if (probability < threshold) return null;

  const similarities = plan.references.map((reference) => semanticSimilarity(target?.text, reference.text));
  if (median(similarities) > ALPHA_MAJORITY_MAX_SIMILARITY) return null;

  return {
    hit: true,
    score: round3(clamp01(rawScore / (ALPHA_SCORE_LEVELS - 1))),
    reason: ALPHA_REASON,
    referenceCount: plan.references.length,
    summary: ALPHA_SUMMARY,
  };
}

/**
 * 把一次语义调用的答案读成 `{ beta, alpha }`（两者都可能为 null）。
 * α 命中优先于 β 折叠：`alpha.hit` 时 `beta.folded === false`（仍然保留组信息供 UI 展示）。
 */
export function readSemanticsAnswers(answers, { plan, target, settings }) {
  const betaCfg = settings?.semantics?.beta ?? {};
  const alphaCfg = settings?.semantics?.alpha ?? {};
  let beta = readBeta(answers ?? {}, plan, target, betaCfg);
  const alpha = readAlpha(answers ?? {}, plan, target, alphaCfg);
  if (alpha?.hit && beta) beta = { ...beta, folded: false };
  return { beta, alpha };
}
