/**
 * 设置：默认值、白名单合并、校验与持久化。
 *
 * 设计约定
 * - 阈值全部是「置信度闸门」：Jev 的回答只有在足够自信时才触发动作，
 *   低置信度一律降级为「仅隐藏 + 待确认」或「忽略」，绝不自动拉黑。
 * - 破坏性动作（静音/拉黑）默认演练（dryRun: true），必须先看清日志再手动关闭。
 */
import { clampInt, clampNumber, isPlainObject, mergeKnown } from './util.js';

export const SETTINGS_KEY = 'jevx.settings';
export const STATS_KEY = 'jevx.stats';
export const BLOCKLIST_KEY = 'jevx.blocklist';
export const AUDIT_KEY = 'jevx.auditLog';
export const FEEDBACK_KEY = 'jevx.feedback';

/** Jev 提供方预设（与 vendored jev-systemone 的 PRESETS 对齐）。 */
export const API_PRESETS = {
  typesafe: {
    label: 'TypeSafe 官方（jev-latest，需要 API Key；推荐）',
    baseURL: 'https://api.typesafe.ai',
    model: 'jev-latest',
    needsKey: true,
  },
  zen: {
    label: 'OpenCode Zen（jev-1.13-free，免费免密钥，想零成本试水选这个）',
    baseURL: 'https://opencode.ai/zen',
    model: 'jev-1.13-free',
    needsKey: false,
  },
  openrouter: {
    label: 'OpenRouter（typesafe/jev-1.13，需要 Key）',
    baseURL: 'https://openrouter.ai/api',
    model: 'typesafe/jev-1.13',
    needsKey: true,
  },
  vercel: {
    label: 'Vercel AI Gateway（typesafe-ai/jev，需要 Key）',
    baseURL: 'https://ai-gateway.vercel.sh',
    model: 'typesafe-ai/jev',
    needsKey: true,
  },
  custom: {
    label: '自定义网关（自填 baseURL / 模型，可指向本地代理）',
    baseURL: '',
    model: '',
    needsKey: false,
  },
};

export const DEFAULT_SETTINGS = {
  /** 2 = 信息过滤器（多类别）；1 = 早期的黄推过滤器。normalizeSettings 会迁移旧键。 */
  schema: 2,
  enabled: true,
  api: {
    preset: 'typesafe',
    baseURL: '',
    model: '',
    path: '/v1/systemone',
    apiKey: '',
    timeoutMs: 12000,
    maxRetries: 2,
  },
  thresholds: {
    /** noul「是色情/色情引流」概率 ≥ 该值 + 类别置信度达标 → 可执行拉黑。 */
    blockNoul: 0.9,
    blockConfidence: 0.7,
    /** 隐藏阈值（低于 block 阈值，用于「先隐藏、不动作」的中间地带）。 */
    hideNoul: 0.65,
    hideConfidence: 0.45,
    /** 本地肤色启发式：可疑 / 极可能裸露。 */
    mediaSuspiciousRatio: 0.45,
    /** 0.62 会把泳装/海边照也判成「极可能裸露」，实测后提到 0.70。 */
    mediaBlockedRatio: 0.7,
    /**
     * 「双确认」闸门：两个独立的 Noul（色情概率 + 站外引流概率）同时很高、
     * 且类别置信度极高时，才把商业色情推广升到 block 档。
     * 真实 Jev 对「OnlyFans 打折 / 链接在简介」这类明确推广常给出 0.85 附近，
     * 单条 Noul 达不到 0.9；要求两条互相印证可以既抓到它、又不放松单条阈值。
     */
    dualAdult: 0.8,
    dualSolicitation: 0.8,
    dualConfidence: 0.95,
    /** 预检（单问）：≥ junkReview 只隐藏待确认；≥ junkEscalate 再花一次完整五问。 */
    junkReview: 0.65,
    junkEscalate: 0.75,
    /** 账号动作者要的程度分与欺骗概率（与 blockNoul/blockConfidence 并列的硬度证据）。 */
    blockSeverity: 2,
    blockDeceptive: 0.85,
    /** 隐藏/待确认的程度分与置信度线。 */
    hideSeverity: 2,
    reviewConfidence: 0.3,
    /** 文案农场（重复刷屏）：至少要有一条这个量级的色情/诱饵信号才动手。 */
    farmBaitMin: 0.4,
    farmAdultMin: 0.4,
  },
  action: {
    /** 过滤本体：命中即隐藏。 */
    hide: true,
    /** 破坏性动作：默认只静音（可逆性比拉黑好），拉黑需显式打开。 */
    autoMute: true,
    autoBlock: false,
    /** 演练模式：只记录「本应执行」的动作，不真的点菜单。默认开启。 */
    dryRun: true,
    /**
     * 「隐藏档也静音」：默认关闭。打开后，`hide` 档（含文案农场、预检命中）的账号也会被静音。
     * 这是用户显式选择的激进档 —— 建议先把 dryRun 当成观察期，确认误伤率再关掉。
     */
    muteOnHide: false,
    /** 每次动作之间的间隔，避免触发风控。 */
    actionDelayMs: 1500,
    maxActionsPerHour: 20,
    maxActionsPerDay: 100,
  },
  scope: {
    timeline: true,
    replies: true,
    recommended: true,
    /** 只分析进入视口的推文，控制请求量与隐私面。 */
    onlyVisible: true,
    /** 文案短于该长度且无媒体时直接跳过（纯贴图黄推另行处理）。 */
    minTextLength: 4,
  },
  media: {
    enabled: true,
    /** 只有文案命中预筛、或文案极短（“只发图”的黄推）时才去下载图片分析。 */
    onlyWhenSuspect: true,
    maxImagesPerTweet: 2,
    /** 可选视觉模型（Jev 不能看图）；默认关闭。 */
    visionEnabled: false,
    visionBaseURL: '',
    visionModel: '',
    visionApiKey: '',
    visionTimeoutMs: 15000,
  },
  /**
   * 类别开关：一个类别关掉 = 该类别不隐藏、不动作（宁可漏杀，不可误杀）。
   * 键名是 `categories.js` 里的分组名；`farm` 是结构信号（同文案刷屏）单独一组。
   */
  categories: {
    adult: { enabled: true },
    scam: { enabled: true },
    ad_spam: { enabled: true },
    clickbait: { enabled: true },
    low_quality: { enabled: true },
    farm: { enabled: true },
  },
  /**
   * 文案农场（重复刷屏）检测：同一段无实质内容的话被 N 个不同账号在短时间内复制。
   * 真站形态：回复区里 4 个随机账号在同一分钟刷同一句文案。
   */
  farm: {
    enabled: true,
    windowMs: 1800000,
    /**
     * 2 个不同账号发同一段（归一化后）无实质内容的话就算农场。
     * 为什么敢降到 2：动手前还要求至少一条色情/诱饵/本地信号（见 gate 的 farm_repeat 规则），
     * 「两个人恰好发了同一句长句 + 其中还有黑话」几乎只有协同账号才会发生。
     */
    minAccounts: 2,
    /** 近似去重的相似度阈值（字符 3-gram Jaccard）：农场账号会在同一句里各插不同垃圾字符。 */
    minSimilarity: 0.8,
  },
  /**
   * 预检（模型先行，解决「关键词表就是召回上限」）：
   * 没被预筛命中的推文也会被问一句廉价单问。关掉它就回到 0 成本的纯本地跳过模式。
   */
  triage: {
    enabled: true,
    sampleRate: 1,
    maxPerMinute: 20,
    maxPerDay: 600,
  },
  /**
   * α / β 语义层（只做「折叠展示」与「标记」，**绝不改变 band / accountAction** —— 不变量 I1）。
   *
   * - β：重复 / 类似 / 同一主张 → 只显示一次（`decision.beta.duplicateOf` + `folded`）；
   *   候选先在本地筛（归一化文本 3-gram ≥0.45、同 threadId、同农场簇），命中才发一次模型调用。
   *   `foldInFeed` / `foldInReplies` 决定哪些场景允许折叠（timeline/recommended 看前者，reply 看后者）；
   *   对应开关关掉时连 β 的问题都不发。
   * - α：与回复区多数观点明显不同 → 只标记（`decision.alpha.hit` + `score`），不隐藏；
   *   只在 `onlyInReplies` 的场景（reply）且参考评论数 ≥ `minReferences` 时判定。
   * - `maxPerMinute` / `maxPerDay` 是语义整理**自己的**额度上限；语义调用同时计入
   *   `budget.maxJevPerDay` / `budget.maxJevPerMinute` —— 全局上限必须真正兜得住。
   * - `reserveForFiltering` 是给过滤留的**全局** Jev 额度保底（内部调参，不在设置页暴露）：
   *   全局剩余 ≤ 该值时语义层不再调用，保证类判定与预检永远有额度可用。
   */
  semantics: {
    enabled: true,
    /** 给过滤（类判定 / 预检）留的全局 Jev 额度保底。 */
    reserveForFiltering: 50,
    beta: {
      enabled: true,
      /** 组内 max(模型 noul) ≥ 该值 → 折叠。 */
      threshold: 0.7,
      /** 一轮最多比较几条候选（也是问题数上限）。 */
      maxCandidates: 6,
      /** 本地候选窗口：最近多少条推文。 */
      windowSize: 60,
      foldInFeed: true,
      foldInReplies: true,
      /** 情绪 / 认同 / 确认这类「没有实质内容的附和」：同一线程只留最早的一条（本地判定，0 调用）。 */
      foldLowSignal: true,
    },
    alpha: {
      enabled: true,
      onlyInReplies: true,
      /** `alpha_majority` 概率 ≥ 该值 → 标记（另加本地相似度护栏）。 */
      threshold: 0.7,
      minReferences: 3,
      maxReferences: 12,
    },
    maxPerMinute: 10,
    maxPerDay: 300,
  },
  budget: {
    maxJevPerMinute: 30,
    maxJevPerDay: 800,
    maxMediaPerMinute: 60,
    concurrency: 3,
    cacheTtlMs: 21600000,
    cacheMaxEntries: 2000,
  },
  audit: {
    /** 可选的审计 webhook：每条判定 POST 一次（也用于端到端测试观测）。 */
    webhookUrl: '',
    logLimit: 500,
  },
  ui: {
    badge: true,
    showReason: true,
    /** 误判反馈按钮：把推文加入白名单。 */
    falsePositiveWhitelist: true,
  },
  whitelist: {
    handles: [],
    keywords: [],
  },
};

/**
 * 把任意输入规范成合法设置：未知字段丢弃、数值夹紧、枚举回退。
 * 永远返回一个完整可用的 settings 对象。
 */
export function normalizeSettings(raw) {
  const input = isPlainObject(raw) ? { ...raw } : {};
  // ---- 迁移：v0.2 的 baitReview/baitEscalate → v0.3 的 junkReview/junkEscalate ----
  if (isPlainObject(input.thresholds)) {
    const t = { ...input.thresholds };
    if (t.junkReview === undefined && t.baitReview !== undefined) t.junkReview = t.baitReview;
    if (t.junkEscalate === undefined && t.baitEscalate !== undefined) t.junkEscalate = t.baitEscalate;
    input.thresholds = t;
  }
  const merged = mergeKnown(DEFAULT_SETTINGS, input);
  const s = merged;

  s.enabled = Boolean(s.enabled);
  s.schema = 2;

  if (!API_PRESETS[s.api.preset]) s.api.preset = 'zen';
  s.api.baseURL = String(s.api.baseURL || '').trim().replace(/\/+$/, '');
  s.api.model = String(s.api.model || '').trim();
  s.api.path = String(s.api.path || '').trim() || '/v1/systemone';
  if (!s.api.path.startsWith('/')) s.api.path = `/${s.api.path}`;
  s.api.apiKey = String(s.api.apiKey || '').trim();
  s.api.timeoutMs = clampInt(s.api.timeoutMs, 1000, 60000, DEFAULT_SETTINGS.api.timeoutMs);
  s.api.maxRetries = clampInt(s.api.maxRetries, 0, 5, DEFAULT_SETTINGS.api.maxRetries);

  s.thresholds.blockNoul = clampNumber(s.thresholds.blockNoul, 0.5, 1, 0.9);
  s.thresholds.blockConfidence = clampNumber(s.thresholds.blockConfidence, 0, 1, 0.7);
  s.thresholds.hideNoul = clampNumber(s.thresholds.hideNoul, 0.3, 1, 0.65);
  s.thresholds.hideConfidence = clampNumber(s.thresholds.hideConfidence, 0, 1, 0.45);
  s.thresholds.mediaSuspiciousRatio = clampNumber(s.thresholds.mediaSuspiciousRatio, 0.1, 1, 0.45);
  s.thresholds.mediaBlockedRatio = clampNumber(s.thresholds.mediaBlockedRatio, 0.2, 1, 0.7);
  s.thresholds.dualAdult = clampNumber(s.thresholds.dualAdult, 0.5, 1, 0.8);
  s.thresholds.dualSolicitation = clampNumber(s.thresholds.dualSolicitation, 0.5, 1, 0.8);
  s.thresholds.dualConfidence = clampNumber(s.thresholds.dualConfidence, 0.5, 1, 0.95);
  s.thresholds.junkReview = clampNumber(s.thresholds.junkReview, 0.3, 1, 0.65);
  s.thresholds.junkEscalate = clampNumber(s.thresholds.junkEscalate, 0.3, 1, 0.75);
  s.thresholds.blockSeverity = clampNumber(s.thresholds.blockSeverity, 1, 4, 2);
  s.thresholds.blockDeceptive = clampNumber(s.thresholds.blockDeceptive, 0.5, 1, 0.85);
  s.thresholds.hideSeverity = clampNumber(s.thresholds.hideSeverity, 1, 4, 2);
  s.thresholds.reviewConfidence = clampNumber(s.thresholds.reviewConfidence, 0.1, 1, 0.3);
  s.thresholds.farmBaitMin = clampNumber(s.thresholds.farmBaitMin, 0, 1, 0.4);
  s.thresholds.farmAdultMin = clampNumber(s.thresholds.farmAdultMin, 0, 1, 0.4);
  // 升级线不应低于隐藏线，否则「只隐藏」这条路径形同虚设。
  s.thresholds.junkEscalate = Math.max(s.thresholds.junkEscalate, s.thresholds.junkReview);
  // 待确认线不应高于隐藏线，否则中间地带为空。
  s.thresholds.reviewConfidence = Math.min(s.thresholds.reviewConfidence, s.thresholds.hideConfidence);
  s.thresholds.hideSeverity = Math.min(s.thresholds.hideSeverity, s.thresholds.blockSeverity);
  // 隐藏阈值不应高于拉黑阈值，否则中间地带为空。
  s.thresholds.hideNoul = Math.min(s.thresholds.hideNoul, s.thresholds.blockNoul);
  s.thresholds.hideConfidence = Math.min(s.thresholds.hideConfidence, s.thresholds.blockConfidence);

  for (const key of ['hide', 'autoMute', 'autoBlock', 'dryRun', 'muteOnHide']) s.action[key] = Boolean(s.action[key]);
  s.action.actionDelayMs = clampInt(s.action.actionDelayMs, 0, 60000, 1500);
  s.action.maxActionsPerHour = clampInt(s.action.maxActionsPerHour, 0, 500, 20);
  s.action.maxActionsPerDay = clampInt(s.action.maxActionsPerDay, 0, 5000, 100);

  for (const key of ['timeline', 'replies', 'recommended', 'onlyVisible']) s.scope[key] = Boolean(s.scope[key]);
  s.scope.minTextLength = clampInt(s.scope.minTextLength, 0, 200, 4);

  s.media.enabled = Boolean(s.media.enabled);
  s.media.onlyWhenSuspect = Boolean(s.media.onlyWhenSuspect);
  s.media.maxImagesPerTweet = clampInt(s.media.maxImagesPerTweet, 0, 4, 2);
  s.media.visionEnabled = Boolean(s.media.visionEnabled);
  s.media.visionBaseURL = String(s.media.visionBaseURL || '').trim().replace(/\/+$/, '');
  s.media.visionModel = String(s.media.visionModel || '').trim();
  s.media.visionApiKey = String(s.media.visionApiKey || '').trim();
  s.media.visionTimeoutMs = clampInt(s.media.visionTimeoutMs, 1000, 60000, 15000);

  for (const [group, value] of Object.entries(s.categories)) {
    s.categories[group] = { enabled: value?.enabled !== false };
  }

  s.farm.enabled = Boolean(s.farm.enabled);
  s.farm.windowMs = clampInt(s.farm.windowMs, 60000, 86400000, 1800000);
  s.farm.minAccounts = clampInt(s.farm.minAccounts, 2, 20, 2);
  s.farm.minSimilarity = clampNumber(s.farm.minSimilarity, 0.5, 1, 0.8);

  s.triage.enabled = Boolean(s.triage.enabled);
  s.triage.sampleRate = clampNumber(s.triage.sampleRate, 0, 1, 1);
  s.triage.maxPerMinute = clampInt(s.triage.maxPerMinute, 0, 600, 20);
  s.triage.maxPerDay = clampInt(s.triage.maxPerDay, 0, 100000, 600);

  // ---- α / β 语义层 ----
  s.semantics.enabled = Boolean(s.semantics.enabled);
  s.semantics.reserveForFiltering = clampInt(s.semantics.reserveForFiltering, 0, 100000, 50);
  s.semantics.beta.enabled = Boolean(s.semantics.beta.enabled);
  s.semantics.beta.threshold = clampNumber(s.semantics.beta.threshold, 0, 1, 0.7);
  // 允许 0：等于「本地不选候选」，与关掉 β 等效（也让单测能精确构造「0 候选」）。
  s.semantics.beta.maxCandidates = clampInt(s.semantics.beta.maxCandidates, 0, 30, 6);
  s.semantics.beta.windowSize = clampInt(s.semantics.beta.windowSize, 0, 500, 60);
  s.semantics.beta.foldInFeed = Boolean(s.semantics.beta.foldInFeed);
  s.semantics.beta.foldInReplies = Boolean(s.semantics.beta.foldInReplies);
  s.semantics.beta.foldLowSignal = Boolean(s.semantics.beta.foldLowSignal);
  s.semantics.alpha.enabled = Boolean(s.semantics.alpha.enabled);
  s.semantics.alpha.onlyInReplies = Boolean(s.semantics.alpha.onlyInReplies);
  s.semantics.alpha.threshold = clampNumber(s.semantics.alpha.threshold, 0, 1, 0.7);
  s.semantics.alpha.minReferences = clampInt(s.semantics.alpha.minReferences, 1, 30, 3);
  s.semantics.alpha.maxReferences = clampInt(s.semantics.alpha.maxReferences, 1, 50, 12);
  // 参考上限不应低于参考下限，否则 α 永远无法判定。
  s.semantics.alpha.maxReferences = Math.max(s.semantics.alpha.maxReferences, s.semantics.alpha.minReferences);
  s.semantics.maxPerMinute = clampInt(s.semantics.maxPerMinute, 0, 600, 10);
  s.semantics.maxPerDay = clampInt(s.semantics.maxPerDay, 0, 10000, 300);

  s.budget.maxJevPerMinute = clampInt(s.budget.maxJevPerMinute, 0, 600, 30);
  s.budget.maxJevPerDay = clampInt(s.budget.maxJevPerDay, 0, 100000, 800);
  s.budget.maxMediaPerMinute = clampInt(s.budget.maxMediaPerMinute, 0, 600, 60);
  s.budget.concurrency = clampInt(s.budget.concurrency, 1, 8, 3);
  s.budget.cacheTtlMs = clampInt(s.budget.cacheTtlMs, 60000, 604800000, 21600000);
  s.budget.cacheMaxEntries = clampInt(s.budget.cacheMaxEntries, 100, 20000, 2000);

  s.audit.webhookUrl = String(s.audit.webhookUrl || '').trim();
  s.audit.logLimit = clampInt(s.audit.logLimit, 10, 5000, 500);

  for (const key of ['badge', 'showReason', 'falsePositiveWhitelist']) s.ui[key] = Boolean(s.ui[key]);

  s.whitelist.handles = Array.isArray(s.whitelist.handles)
    ? [...new Set(s.whitelist.handles.map((h) => String(h || '').trim().replace(/^@+/, '').toLowerCase()).filter(Boolean))]
    : [];
  s.whitelist.keywords = Array.isArray(s.whitelist.keywords)
    ? [...new Set(s.whitelist.keywords.map((k) => String(k || '').trim()).filter(Boolean))]
    : [];

  return s;
}

/** 解析出真正要用的 endpoint（预设 + 显式覆盖）。 */
export function resolveApi(settings) {
  const s = normalizeSettings(settings);
  const preset = API_PRESETS[s.api.preset] ?? API_PRESETS.zen;
  const baseURL = s.api.baseURL || preset.baseURL;
  const model = s.api.model || preset.model;
  return {
    preset: s.api.preset,
    baseURL,
    model,
    path: s.api.path,
    apiKey: s.api.apiKey,
    timeoutMs: s.api.timeoutMs,
    maxRetries: s.api.maxRetries,
    keylessOk: s.api.preset === 'zen' && !s.api.apiKey,
    /** 是否具备发起调用的最低配置。 */
    ready: Boolean(baseURL && model && (s.api.apiKey || preset.needsKey === false)),
    missing: [
      !baseURL ? 'baseURL' : null,
      !model ? 'model' : null,
      preset.needsKey && !s.api.apiKey ? 'apiKey' : null,
    ].filter(Boolean),
  };
}

/* --------------------------- chrome.storage 包装 --------------------------- */

export function hasChromeStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

export async function loadSettings() {
  if (!hasChromeStorage()) return normalizeSettings(null);
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(got?.[SETTINGS_KEY]);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  if (hasChromeStorage()) await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  return saveSettings(mergeKnown(current, patch));
}
