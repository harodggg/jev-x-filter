/**
 * Service Worker：扩展的唯一网络出口。
 *
 * 职责边界（有意为之）
 * - 所有 Jev / 图片 / 视觉模型请求都在这里发，API Key 只存在 SW 可读的 storage 里，
 *   永不下发给页面上下文（内容脚本也拿不到密钥）。
 * - 内容脚本只做 DOM：抽取、隐藏、点菜单；判定与预算全部由这里裁决。
 * - 判定逻辑本身在 pipeline.js，依赖注入，可在 Node 里单测。
 */
import { JevClient } from '../vendor/jev-systemone/dist/index.js';
import { AUDIT_SOURCE, createAuditor } from './audit.js';
import { buildQuestions } from './classifier.js';
import {
  emptyBlocklist,
  listStats as blocklistStats,
  importInto,
  mergeEntries,
  makeEntry,
  normalizeHandle,
  removeHandle,
  toExport,
} from './blocklist.js';
import { classifyImageWithVision } from './vision.js';
import { analyzeImageUrl } from './media.js';
import { createPipeline } from './pipeline.js';
import {
  AUDIT_KEY,
  BLOCKLIST_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  STATS_KEY,
  loadSettings,
  normalizeSettings,
  resolveApi,
  saveSettings,
} from './settings.js';
import { mergeKnown } from './util.js';

export const VERSION = '0.4.5';

/* ------------------------------- 运行时状态 ------------------------------- */

let settings = normalizeSettings(DEFAULT_SETTINGS);
let blocklist = emptyBlocklist();
let cumulative = { bands: { block: 0, hide: 0, review: 0, ignore: 0 }, actions: 0, since: 0 };
let clientState = { client: null, error: null, configKey: '' };

/**
 * 运行态持久化：MV3 的 Service Worker 会被空闲回收，内存里的农场簇、判定缓存与
 * 调用/动作预算都会清零。农场簇清零会让「同一段文案被多账号刷屏」这条信号失效，
 * 预算清零则会让限速被重启绕过 —— 所以放进 storage.session（浏览器会话内有效，
 * 随 SW 重启保留，必要时退回 storage.local）。
 */
const RUNTIME_KEY = 'jevx.runtime';
const runtimeStore = (() => {
  const area = chrome.storage.session ?? chrome.storage.local;
  return {
    load: async () => (await area.get(RUNTIME_KEY))?.[RUNTIME_KEY] ?? null,
    save: async (snapshot) => {
      await area.set({ [RUNTIME_KEY]: { ...snapshot, savedAt: Date.now() } });
    },
  };
})();

const auditor = createAuditor({
  webhookUrl: settings.audit.webhookUrl,
  limit: settings.audit.logLimit,
  version: VERSION,
});

const pipeline = createPipeline({
  getSettings: () => settings,
  jev: {
    async systemOne(request) {
      const client = ensureClient();
      const api = resolveApi(settings);
      return client.systemOne(request, {
        timeout: api.timeoutMs,
        retry: { maxRetries: api.maxRetries },
      });
    },
  },
  analyzeImage: (url) => analyzeImageUrl(url, { timeoutMs: Math.min(settings.api.timeoutMs, 8000) }),
  classifyWithVision: (url, mediaCfg) => classifyImageWithVision(url, mediaCfg),
  auditor,
  runtime: runtimeStore,
  onActionCandidate: (decision) => {
    void rememberAccount(decision, { source: 'auto', band: decision.band });
  },
});

/** 按配置指纹缓存 Jev 客户端；配置变了才重建。 */
function ensureClient() {
  const api = resolveApi(settings);
  const key = `${api.preset}|${api.baseURL}|${api.model}|${api.path}|${api.apiKey ? 'k' : '-'}`;
  if (clientState.client && clientState.configKey === key) return clientState.client;
  try {
    if (!api.baseURL || !api.model) throw new Error('API 未配置完整（baseURL / model）');
    const client = new JevClient({
      preset: api.preset === 'zen' ? 'zen' : 'custom',
      baseURL: api.baseURL,
      path: api.path,
      apiKey: api.apiKey || undefined,
      defaultModel: api.model,
      timeout: api.timeoutMs,
      // SW 里没有 window，本来就不会触发浏览器的密钥保护；显式打开以免将来在页面里复用时踩坑。
      dangerouslyAllowBrowser: true,
    });
    clientState = { client, error: null, configKey: key };
  } catch (error) {
    clientState = { client: null, error: String(error?.message ?? error), configKey: key };
    throw error;
  }
  return clientState.client;
}

/* ------------------------------ 持久化读写 ------------------------------ */

/** 首次读取 storage 完成前，任何消息都先等它 —— 避免用默认设置（可能指向上游真实网关）判定了前几条。 */
let ready = null;

async function persistBlocklist(next) {
  blocklist = next;
  await chrome.storage.local.set({ [BLOCKLIST_KEY]: blocklist });
  return blocklist;
}

async function rememberAccount(decision, { source = 'auto', band = 'hide' } = {}) {
  const handle = normalizeHandle(decision?.handle);
  if (!handle) return { added: 0, updated: 0 };
  const entry = makeEntry({
    handle,
    band,
    reasons: decision?.reasons ?? [],
    category: decision?.detail?.category ?? null,
    adult: decision?.detail?.adult ?? null,
    categoryConfidence: decision?.detail?.categoryConfidence ?? null,
    source,
    tweetId: decision?.tweetId ?? null,
  });
  const merged = mergeEntries(blocklist, [entry]);
  await persistBlocklist(merged.list);
  return { added: merged.added, updated: merged.updated };
}

async function loadPersisted() {
  const got = await chrome.storage.local.get([SETTINGS_KEY, BLOCKLIST_KEY, STATS_KEY, AUDIT_KEY]);
  settings = normalizeSettings(got?.[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
  blocklist = { ...emptyBlocklist(), ...(got?.[BLOCKLIST_KEY] ?? {}) };
  if (!Array.isArray(blocklist.entries)) blocklist.entries = [];
  if (!blocklist.whitelist) blocklist.whitelist = { handles: [], keywords: [] };
  cumulative = { bands: { block: 0, hide: 0, review: 0, ignore: 0 }, actions: 0, since: Date.now(), ...(got?.[STATS_KEY] ?? {}) };
  auditor.setWebhookUrl(settings.audit.webhookUrl);
  try {
    ensureClient();
  } catch {
    /* 配置不完整时保持 degraded，判定会走降级路径而不是崩溃 */
  }
  return settings;
}

async function flushStats() {
  const s = pipeline.stats();
  for (const band of Object.keys(cumulative.bands)) cumulative.bands[band] += s.bands[band] ?? 0;
  cumulative.actions += 0;
  cumulative.cacheHits = (cumulative.cacheHits ?? 0) + s.cacheHits;
  cumulative.jevCalls = (cumulative.jevCalls ?? 0) + s.jevCalls;
  cumulative.jevErrors = (cumulative.jevErrors ?? 0) + s.jevErrors;
  cumulative.mediaAnalyzed = (cumulative.mediaAnalyzed ?? 0) + s.mediaAnalyzed;
  cumulative.decisions = (cumulative.decisions ?? 0) + s.decisions;
  await chrome.storage.local.set({ [STATS_KEY]: cumulative });
}

/* -------------------------------- 消息路由 -------------------------------- */

const handlers = {
  async JEVX_DECIDE({ tweet }) {
    const decision = await pipeline.decide(tweet);
    return { ok: true, decision };
  },
  async JEVX_GET_SETTINGS() {
    return { ok: true, settings };
  },
  async JEVX_SET_SETTINGS({ patch, replace }) {
    settings = normalizeSettings(replace ? patch : mergeKnown(settings, patch ?? {}));
    await saveSettings(settings);
    auditor.setWebhookUrl(settings.audit.webhookUrl);
    try {
      ensureClient();
    } catch {
      /* 保留 clientState.error 供 UI 展示 */
    }
    broadcast({ type: 'JEVX_SETTINGS_CHANGED', settings });
    return { ok: true, settings };
  },
  async JEVX_GET_STATE() {
    let apiError = clientState.error;
    if (!apiError) {
      try {
        ensureClient();
      } catch (error) {
        apiError = String(error?.message ?? error);
      }
    }
    const api = resolveApi(settings);
    return {
      ok: true,
      version: VERSION,
      settings,
      api: { ...api, apiKey: api.apiKey ? '***' : '' },
      apiError,
      stats: pipeline.stats(),
      cumulative,
      blocklist: blocklistStats(blocklist),
      budget: pipeline.budget(),
      audit: auditor.list().slice(-50),
    };
  },
  async JEVX_TEST_CONNECTION({ text }) {
    const sample = String(text ?? '').trim() || '同城约啪 加电报 t.me/example 少妇上门 视频福利';
    const started = Date.now();
    try {
      const client = ensureClient();
      const api = resolveApi(settings);
      // 注意：MV3 的 Service Worker 里禁止动态 import()（HTML 规范限制），
      // 所以 buildQuestions 必须是顶层静态 import —— 这里曾被端到端测试抓出来过。
      const result = await client.systemOne({ state: sample, questions: buildQuestions() }, { timeout: api.timeoutMs });
      return { ok: true, latencyMs: Date.now() - started, model: result?.model, answers: result?.answers, usage: result?.usage };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: String(error?.message ?? error) };
    }
  },
  async JEVX_AUDIT_EVENT({ event }) {
    await auditor.emit(event ?? {});
    return { ok: true };
  },
  async JEVX_GET_AUDIT() {
    return { ok: true, events: auditor.list() };
  },
  async JEVX_CLEAR_AUDIT() {
    auditor.clear();
    return { ok: true };
  },
  async JEVX_BLOCKLIST_GET() {
    return { ok: true, blocklist, stats: blocklistStats(blocklist) };
  },
  async JEVX_BLOCKLIST_IMPORT({ text }) {
    const result = importInto(blocklist, text);
    if (result.list) await persistBlocklist(result.list);
    return { ok: true, format: result.format, added: result.added ?? 0, updated: result.updated ?? 0, errors: result.errors ?? [], stats: blocklistStats(blocklist) };
  },
  async JEVX_BLOCKLIST_EXPORT() {
    return { ok: true, text: toExport(blocklist) };
  },
  async JEVX_BLOCKLIST_REMOVE({ handle }) {
    await persistBlocklist(removeHandle(blocklist, handle));
    return { ok: true, stats: blocklistStats(blocklist) };
  },
  async JEVX_BLOCKLIST_CLEAR() {
    await persistBlocklist({ ...emptyBlocklist(), whitelist: blocklist.whitelist });
    return { ok: true, stats: blocklistStats(blocklist) };
  },
  async JEVX_WHITELIST_ADD({ handle, keyword }) {
    if (handle) {
      const h = normalizeHandle(handle);
      if (h && !settings.whitelist.handles.includes(h)) {
        settings = normalizeSettings({ ...settings, whitelist: { ...settings.whitelist, handles: [...settings.whitelist.handles, h] } });
      }
    }
    if (keyword) {
      const k = String(keyword).trim();
      if (k && !settings.whitelist.keywords.includes(k)) {
        settings = normalizeSettings({ ...settings, whitelist: { ...settings.whitelist, keywords: [...settings.whitelist.keywords, k] } });
      }
    }
    await saveSettings(settings);
    broadcast({ type: 'JEVX_SETTINGS_CHANGED', settings });
    return { ok: true, settings };
  },
  async JEVX_WHITELIST_REMOVE({ handle }) {
    const h = normalizeHandle(handle);
    settings = normalizeSettings({ ...settings, whitelist: { ...settings.whitelist, handles: settings.whitelist.handles.filter((x) => x !== h) } });
    await saveSettings(settings);
    return { ok: true, settings };
  },
  async JEVX_CLEAR_CACHE() {
    pipeline.clearCache();
    return { ok: true };
  },
  async JEVX_BADGE({ count }, sender) {
    if (!settings.ui.badge) return { ok: true };
    const text = count > 0 ? String(Math.min(999, count)) : '';
    const tabId = sender?.tab?.id;
    const target = typeof tabId === 'number' ? { tabId } : {};
    try {
      await chrome.action.setBadgeText({ ...target, text });
      await chrome.action.setBadgeBackgroundColor({ ...target, color: '#c0392b' });
    } catch {
      /* 标签页可能已关闭 */
    }
    return { ok: true };
  },
};

function broadcast(message) {
  chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }, (tabs) => {
    for (const tab of tabs ?? []) {
      if (typeof tab.id === 'number') chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(ready)
    .then(() => handler(message, sender))
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true; // 异步响应
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  auditor.setWebhookUrl(settings.audit.webhookUrl);
  try {
    ensureClient();
  } catch {
    /* 保留错误状态 */
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'jevx.flush') void flushStats();
  if (alarm.name === 'jevx.audit') void pruneAudit();
});

async function pruneAudit() {
  const got = await chrome.storage.local.get(AUDIT_KEY);
  const log = Array.isArray(got?.[AUDIT_KEY]) ? got[AUDIT_KEY] : [];
  const merged = [...log, ...auditor.list()].slice(-settings.audit.logLimit);
  await chrome.storage.local.set({ [AUDIT_KEY]: merged });
  auditor.clear();
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('jevx.flush', { periodInMinutes: 5 });
  await chrome.alarms.create('jevx.audit', { periodInMinutes: 60 });
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  if (!got?.[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(DEFAULT_SETTINGS) });
  await chrome.storage.local.set({ [BLOCKLIST_KEY]: emptyBlocklist() });
  ready = loadPersisted();
  await ready;
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create('jevx.flush', { periodInMinutes: 5 });
  ready = loadPersisted();
});

ready = loadPersisted();

// 供端到端测试在 SW 上下文里读取内部状态（正常使用时只是只读出口）。
globalThis.__jevx = {
  get settings() {
    return settings;
  },
  pipelineStats: () => pipeline.stats(),
  recentDecisions: () => pipeline.recent(),
  recentInputs: () => pipeline.recentInputs?.() ?? [],
  auditorList: () => auditor.list(),
  storage: () => ({ settings, blocklist, cumulative }),
  source: AUDIT_SOURCE,
};
