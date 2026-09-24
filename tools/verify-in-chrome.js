/**
 * 端到端验证（真实 Chrome + 真实扩展 + 本地 mock Jev 服务）。
 *
 * 为什么要这一步：单测覆盖不了「Chrome 是否肯加载这个 MV3 扩展」「Service Worker 里
 * 官方 Jev 客户端能不能发出正确的请求」「内容脚本能不能真的把推文藏起来并点中菜单」
 * 「OffscreenCanvas 图片分析在 SW 里能不能跑」。这里全部在真浏览器里跑一遍。
 *
 * 做法：
 *   1. 把扩展复制到 .tmp-ext/，只改一处 —— manifest 额外允许 http://127.0.0.1/*
 *      （本地夹具页面与 mock 网关），分发的 manifest 不受影响；
 *   2. 起一个本地服务器：`/` 返回仿 X 的夹具页面，`POST /v1/systemone` 扮演 Jev，
 *      `POST /audit` 收审计 webhook，`/skin.png` 提供肤色图；
 *   3. 用 CDP 的 Extensions.loadUnpacked 加载扩展（Chrome 137+ 已移除 --load-extension）；
 *   4. 场景 A（演练模式）与场景 B（已武装 + 只分析视口内推文）分别断言。
 *
 * 用法：node tools/verify-in-chrome.js
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skinTonePng } from './png.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 副本必须放在项目目录之外（Node 不允许把目录复制进自己的子目录），
// 但仍然落在同一个工作区内，避免污染临时目录或需要额外权限。
const EXT_DIR = path.resolve(ROOT, '..', '.scratch', 'jevx-e2e-ext');
const PROFILE_DIR = path.join(ROOT, '.tmp-chrome-profile');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.TEST_PORT || 8231);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9433);
const BASE = `http://127.0.0.1:${PORT}`;

/* ============================== 夹具页面 ============================== */

const SPAM_ZH = '同城约啪 加电报 t.me/e2e 少妇上门 视频福利';
const SPAM_EN = 'Escort services in your city, DM for menu';
const ORDINARY = 'ORDINARY 今天天气不错，我们一起去公园散步吧，顺便看看新开的书店';
const NEWS = 'ORDINARY 警方通报：专项行动打击约炮平台与色情网站，已查处多个窝点';
const WEAK_IMAGE = '极品模特 真人福利 在线看';
const FARM_TEXT = '应该没人比我玩的开了吧🤣💖我福不黑不信你看';

function article(id, handle, text, { photo = false, displayName = null } = {}) {
  return `
  <div data-testid="cellInnerDiv">
    <article data-testid="tweet" data-h="${handle}" id="tweet-${id}">
      <div data-testid="User-Name"><a href="/${handle}">${displayName ?? `${handle} 官方`}</a><a href="/${handle}">@${handle}</a></div>
      <a href="/${handle}/status/${id}"><time datetime="2026-01-01T00:00:00.000Z">1h</time></a>
      ${photo ? `<div data-testid="tweetPhoto"><img src="${BASE}/skin.png" alt=""></div>` : ''}
      <div data-testid="tweetText">${text}</div>
      <button data-testid="caret" aria-label="More" onclick="toggleMenu('${handle}')">⋯</button>
    </article>
  </div>`;
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>仿 X 夹具页</title>
<style>body{font:14px/1.5 sans-serif;margin:0}article{display:block;padding:12px;border-bottom:1px solid #ddd}
img{width:80px;height:80px}[role=menuitem]{padding:8px;cursor:pointer}
[data-testid=Dropdown]{position:fixed;top:10px;right:10px;background:#fff;border:1px solid #ccc;z-index:9}
</style></head>
<body>
<div data-testid="primaryColumn">
  <h1>时间线</h1>
  <!-- 陷阱 1：页面里早就挂着一个文案命中「确认拉黑」的确认按钮（X 复用同一个 testid），
       自动化必须只点「拉黑后新出现的那个」，否则会点到它。 -->
  <button data-testid="confirmationSheetConfirm" id="stale-confirm" onclick="window.__actions.push({kind:'decoy-click'})">Block</button>
  ${article('111', 'spammer1', SPAM_ZH)}
  ${article('222', 'normal2', ORDINARY)}
  ${article('333', 'escort4', SPAM_EN)}
  ${article('444', 'news5', NEWS)}
  ${article('555', 'pic6', '看', { photo: true })}
  ${article('666', 'weak7', WEAK_IMAGE, { photo: true })}
  <!-- 真站漏检样本 1：引流全写在显示名里，正文写成无害的「不是人机」 -->
  ${article('777', 'JesseAlvarl3', '那一夜你没有拒绝我😭🤣不是人机', { displayName: '🍑真实同城约p🍑主页联系🔞免费' })}
  <!-- 真站漏检样本 2：正文与显示名都没有任何关键词（乱码账号名 + 性暗示自夸），
       只能靠预检（模型先行）捞出来 -->
  ${article('888', 'yrmyzhcxvlkzpu', '比我好看的没我骚🔧👏比我骚的没我好看', { displayName: 'yrmyzh cxvlu' })}
  <!-- 信息过滤器新增类别：诈骗（可动账号）与标题党（只隐藏） -->
  ${article('1001', 'stockguru88', '内幕消息：跟随老师操作，月入十万，稳赚不赔，加V领取建仓表')}
  ${article('1002', 'buzzfeed_cn', '不看后悔一辈子！删前速看，99%的人都不知道的真相')}
  <!-- 真站样本 4：显示名写「处男免费」，正文用 emoji 拆字「处🐕男」规避关键字匹配 -->
  ${article('999', 'czex7Jacquline', '祝你有美好的一天🟧处🐕男🚹恭喜 发财', { displayName: '不药而愈丶❤️处男免费❤️' })}
  <!-- 真站样本 3：回复区里的文案农场（同一句被多个账号刷） -->
  ${article('901', 'ThomasTurnyysr', FARM_TEXT, { displayName: '靖柏🌸' })}
  ${article('902', 'TinaMysersyro', FARM_TEXT, { displayName: '夜蓉🌸' })}
  ${article('903', 'TimothyAndjqqx', FARM_TEXT, { displayName: '迎晴🌸' })}
</div>
<script>
  window.__actions = [];
  window.closeMenu = function () { document.querySelectorAll('[data-testid="Dropdown"]').forEach(function (n) { n.remove(); }); };
  window.showConfirm = function (handle) {
    var sheet = document.createElement('div');
    sheet.id = 'confirm-sheet';
    var btn = document.createElement('button');
    btn.setAttribute('data-testid', 'confirmationSheetConfirm');
    btn.textContent = 'Block';
    btn.addEventListener('click', function () {
      window.__actions.push({ kind: 'block-confirmed', handle: handle });
      sheet.remove();
    });
    sheet.appendChild(btn);
    document.body.appendChild(sheet);
  };
  window.choose = function (kind, handle) {
    window.__actions.push({ kind: kind, handle: handle, at: Date.now() });
    window.closeMenu();
    if (kind === 'block') window.showConfirm(handle);
  };
  window.toggleMenu = function (handle) {
    var open = document.querySelector('[data-testid="Dropdown"]');
    if (open) { window.closeMenu(); return; }
    var menu = document.createElement('div');
    menu.setAttribute('data-testid', 'Dropdown');
    menu.setAttribute('role', 'menu');
    // 陷阱 2：菜单里同时给出反义项（Unmute/Unblock），且静音项不带 testid —— 
    // 逼着实现走「先排除反义项再按文案匹配」，点错就会被断言抓到。
    var entries = [
      { label: 'Unmute @' + handle, kind: 'unmute' },
      { label: 'Mute @' + handle, kind: 'mute' },
      { label: 'Unblock @' + handle, kind: 'unblock', testid: 'unblock' },
      { label: 'Block @' + handle, kind: 'block', testid: 'block' }
    ];
    entries.forEach(function (entry) {
      var item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      if (entry.testid) item.setAttribute('data-testid', entry.testid);
      item.textContent = entry.label;
      item.addEventListener('click', function () { window.choose(entry.kind, handle); });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
  };
</script>
</body></html>`;
}

/* ============================== mock 服务 ============================== */

function answersFor(state) {
  const s = String(state);
  const base = {
    solicitation: { type: 'noul', noul: 0.05 },
    deceptive: { type: 'noul', noul: 0.03 },
    severity: { type: 'score', score: 1, confidence: 0.8, legend: {}, probabilities: {} },
  };
  if (/荐股|稳赚|内幕|加V领取|月入/.test(s)) {
    // 诈骗类：欺骗概率高 + 程度 3 → block（可动账号）
    return {
      ...base,
      adult: { type: 'noul', noul: 0.02 },
      solicitation: { type: 'noul', noul: 0.55 },
      deceptive: { type: 'noul', noul: 0.93 },
      category: { type: 'choice', choice: 'scam', confidence: 0.9, probabilities: { scam: 0.9, ad_spam: 0.08, other: 0.02 } },
      severity: { type: 'score', score: 3, confidence: 0.9, legend: {}, probabilities: {} },
    };
  }
  if (/不看后悔|删前速看|99%的人/.test(s)) {
    // 标题党：只隐藏，不动账号（accountEligible=false）
    return {
      ...base,
      adult: { type: 'noul', noul: 0.01 },
      deceptive: { type: 'noul', noul: 0.42 },
      category: { type: 'choice', choice: 'clickbait', confidence: 0.88, probabilities: { clickbait: 0.88, low_quality: 0.1, ordinary: 0.02 } },
      severity: { type: 'score', score: 2.2, confidence: 0.8, legend: {}, probabilities: {} },
    };
  }
  if (/ORDINARY/.test(s)) {
    return {
      ...base,
      adult: { type: 'noul', noul: 0.04 },
      category: { type: 'choice', choice: 'ordinary', confidence: 0.93, probabilities: { ordinary: 0.93, other: 0.07 } },
    };
  }
  if (/处男|破处|炮友/.test(s)) {
    // 真站实测：adult 0.74 / 类别 adult_solicitation / 置信度 0.25 → 隐藏但不静音
    return {
      adult: { type: 'noul', noul: 0.74 },
      solicitation: { type: 'noul', noul: 0.08 },
      category: { type: 'choice', choice: 'adult_solicitation', confidence: 0.25, probabilities: { adult_solicitation: 0.25, suggestive: 0.4, ordinary: 0.35 } },
      severity: { type: 'score', score: 2, confidence: 0.6, legend: {}, probabilities: {} },
    };
  }
  if (/同城约|onlyfans|escort|主页联系/i.test(s)) {
    return {
      adult: { type: 'noul', noul: 0.97 },
      solicitation: { type: 'noul', noul: 0.94 },
      category: { type: 'choice', choice: 'adult_solicitation', confidence: 0.93, probabilities: { adult_solicitation: 0.93, adult_porn: 0.05, other: 0.02 } },
      severity: { type: 'score', score: 3.2, confidence: 0.9, legend: {}, probabilities: {} },
    };
  }
  return {
    ...base,
    adult: { type: 'noul', noul: 0.2 },
    category: { type: 'choice', choice: 'other', confidence: 0.6, probabilities: { other: 0.6, ordinary: 0.4 } },
  };
}

/**
 * 预检（单问）的答案：模拟真实模型的行为 —— 对「骚式自夸 + 乱码账号名」给 0.80，
 * 对普通推文给极低分（实测对照 0.02–0.13）。
 */
function junkFor(state) {
  if (/比我骚|骚/.test(state)) return 0.8; // ≥ 升级线 0.75 → 再问完整四问
  if (/玩的开了|我福不黑/.test(state)) return 0.54; // 实测值：单看文案模型也不确定，靠农场补刀
  if (/ORDINARY/.test(state)) return 0.04;
  return 0.15;
}

function startMockServer() {
  const state = { jev: [], audits: [] };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/skin.png')) {
      const png = skinTonePng(64);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      res.end(png);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/systemone') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        state.jev.push({ url: req.url, headers: req.headers, body: parsed, at: Date.now() });
        const questionIds = Object.keys(parsed.questions ?? {});
        const isProbe = questionIds.length === 1 && questionIds[0] === 'junk';
        const payload = {
          model: parsed.model ?? 'jev-test',
          answers: isProbe ? { junk: { type: 'noul', noul: junkFor(parsed.state ?? '') } } : answersFor(parsed.state ?? ''),
          usage: { input_tokens: isProbe ? 90 : 220, output_tokens: isProbe ? 12 : 40 },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/audit') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          state.audits.push(JSON.parse(body));
        } catch {
          state.audits.push({ raw: body });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({ server, state }));
  });
}

/* ============================== 极简 CDP ============================== */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败: ${url}`)));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常: ${JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails.text)}`);
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 25000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = { error: String(error.message) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${label}）：${JSON.stringify(last)}`);
}

async function devtoolsReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}

/* ============================== 断言收集 ============================== */

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ============================== 准备扩展副本 ============================== */

function prepareExtensionCopy() {
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  fs.cpSync(ROOT, EXT_DIR, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const blocked = ['.tmp-ext', '.tmp-chrome-profile', '.screenshots', 'node_modules', '.git', 'tests', 'tools'];
      return !blocked.some((b) => rel === b || rel.startsWith(`${b}${path.sep}`));
    },
  });

  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const LOCAL = 'http://127.0.0.1/*';
  const anchor = 'https://x.com/*';
  if (!manifest.content_scripts[0].matches.includes(anchor)) throw new Error('manifest 锚点漂移：content_scripts.matches');
  manifest.content_scripts[0].matches.push(LOCAL);
  manifest.host_permissions.push(LOCAL);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return EXT_DIR;
}

/* ============================== 主流程 ============================== */

const PROBE = `(() => {
  const out = {};
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    out[a.id.replace('tweet-', '')] = {
      hidden: a.getAttribute('data-jevx-hidden') === '1',
      band: a.getAttribute('data-jevx-state'),
      source: a.getAttribute('data-jevx-source'),
      bar: (a.querySelector(':scope > .jevx-bar')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
    };
  }
  return { articles: out, actions: (window.__actions || []).slice(), bodyLen: document.body.textContent.length };
})()`;

const SW_PROBE = `(() => ({
  stats: globalThis.__jevx?.pipelineStats?.() ?? null,
  audit: (globalThis.__jevx?.auditorList?.() ?? []).slice(-40),
  settings: globalThis.__jevx?.settings ?? null,
}))()`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`未找到 Chrome: ${CHROME}`);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  const extensionPath = prepareExtensionCopy();
  const { server, state: mock } = await startMockServer();

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints,HttpsUpgrades',
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--enable-unsafe-extension-debugging',
      '--window-size=1200,1600',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chromeLog = [];
  chrome.stdout.on('data', (d) => chromeLog.push(String(d)));
  chrome.stderr.on('data', (d) => chromeLog.push(String(d)));

  let browser = null;
  try {
    const version = await devtoolsReady();
    console.log(`Chrome: ${version.Browser}`);
    browser = await CDP.connect(version.webSocketDebuggerUrl);

    // ---- 1. 加载扩展 ----
    const loaded = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
    if (!loaded?.id) throw new Error(`扩展加载失败：${JSON.stringify(loaded)}`);
    const extId = loaded.id;
    console.log(`扩展已加载：${extId}\n`);

    const openPage = async (url, { captureErrors = true } = {}) => {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const targets = await listTargets();
      const target = targets.find((t) => t.id === targetId);
      if (!target) throw new Error(`找不到目标: ${url}`);
      const cdp = await CDP.connect(target.webSocketDebuggerUrl);
      const errors = [];
      if (captureErrors) {
        cdp.on('Runtime.exceptionThrown', (params) => {
          const details = params.exceptionDetails ?? {};
          errors.push(details.exception?.description ?? details.text ?? 'unknown');
        });
        cdp.on('Runtime.consoleAPICalled', (params) => {
          if (params.type === 'error') errors.push(`console.error: ${(params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
        });
      }
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url });
      await sleep(700);
      return { cdp, errors, targetId };
    };

    const swTarget = async () => {
      const targets = await listTargets();
      const found = targets.find((t) => (t.type === 'service_worker' || t.type === 'worker') && t.url.includes(extId));
      if (!found) return null;
      const cdp = await CDP.connect(found.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      return cdp;
    };

    // ---- 2. 通过设置页写入测试配置（mock 网关 + 审计 webhook） ----
    const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
    const optionsPage = await openPage(optionsUrl);
    await sleep(1200);

    /**
     * 写测试配置，并**等 Service Worker 真的切换过去**再继续。
     * 早期版本只 sleep 600ms，结果场景 D 拿到了场景 C 的配置（动作类型整个错位）——
     * 这类竞态会让断言变成「碰运气」，所以这里改成轮询 SW 的实际状态。
     */
    const configure = async (patch) => {
      const applied = await optionsPage.cdp.evaluate(
        `(async () => {
           await chrome.storage.local.set({ 'jevx.settings': ${JSON.stringify(patch)} });
           return true;
         })()`,
      );
      if (!applied) throw new Error('写入测试设置失败');
      // 逐字段比对（只比 patch 里给过的字段）：归一化会补默认值，整块 JSON 对比会永远不相等。
      const patchFields = (block) => Object.entries(patch[block] ?? {});
      const sameBlock = (state, block) => patchFields(block).every(([key, value]) => state?.[block]?.[key] === value);
      await waitFor(
        async () => {
          const state = await optionsPage.cdp.evaluate(
            `(async () => {
               const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'JEVX_GET_STATE' }, resolve));
               return res?.settings ?? null;
             })()`,
          );
          if (!state) return null;
          return ['action', 'scope', 'triage', 'farm'].every((block) => sameBlock(state, block)) ? state : null;
        },
        { label: 'Service Worker 应用新配置', timeoutMs: 10000, intervalMs: 150 },
      );
    };

    const baseSettings = {
      enabled: true,
      api: { preset: 'custom', baseURL: BASE, model: 'jev-test', apiKey: 'e2e-key', path: '/v1/systemone', timeoutMs: 8000, maxRetries: 0 },
      audit: { webhookUrl: `${BASE}/audit`, logLimit: 500 },
      budget: { maxJevPerMinute: 60, maxJevPerDay: 500, maxMediaPerMinute: 60, concurrency: 3, cacheTtlMs: 21600000, cacheMaxEntries: 500 },
      scope: { timeline: true, replies: true, recommended: true, onlyVisible: false, minTextLength: 4 },
    };
    await configure({ ...baseSettings, action: { hide: true, autoMute: true, autoBlock: false, dryRun: true, actionDelayMs: 300, maxActionsPerHour: 20, maxActionsPerDay: 100 } });

    // ---- 3. 场景 A：演练模式 ----
    console.log('场景 A：演练模式（只隐藏，不点菜单）');
    const pageA = await openPage(`${BASE}/?scenario=a`);
    let probeA = null;
    try {
      probeA = await waitFor(
        async () => {
          const p = await pageA.cdp.evaluate(PROBE);
          const hidden = Object.values(p.articles).filter((a) => a.hidden).length;
          return hidden >= 12 ? p : null;
        },
        { label: '场景 A 出现 3 条隐藏推文' },
      );
    } catch (error) {
      probeA = await pageA.cdp.evaluate(PROBE).catch(() => ({ articles: {}, actions: [] }));
      check('场景 A 十二条可疑推文被隐藏', false, String(error.message));
    }

    const a = probeA.articles ?? {};
    check('黄推（中文引流）被隐藏', a['111']?.hidden === true, `band=${a['111']?.band}`);
    check('黄推（英文 escort）被隐藏', a['333']?.hidden === true, `band=${a['333']?.band}`);
    check('图片佐证 + 弱文案 被隐藏（I1：不升级为账号动作）', a['666']?.hidden === true, `band=${a['666']?.band}`);
    check('诈骗类（荐股/稳赚/加V领取）被判定为 block 档', a['1001']?.hidden === true && a['1001']?.band === 'block', `band=${a['1001']?.band}`);
    check('标题党被隐藏但不进入动作档（该类别不可动账号）', a['1002']?.hidden === true && a['1002']?.band === 'hide', `band=${a['1002']?.band}`);
    check(
      'emoji 拆字（处🐕男）+ 显示名黑话（处男免费）被隐藏为「待确认」',
      a['999']?.hidden === true && a['999']?.band === 'hide',
      `band=${a['999']?.band}`,
    );
    check(
      '文案农场全部隐藏（含被追溯隐藏的更早条目）',
      a['901']?.hidden === true && a['902']?.hidden === true && a['903']?.hidden === true,
      `901=${a['901']?.band}/${a['901']?.source} 902=${a['902']?.band} 903=${a['903']?.band}`,
    );
    check(
      '真站漏检样本 2（无任何关键词，靠预检捞出）被隐藏为待确认',
      a['888']?.hidden === true && a['888']?.band === 'review',
      `band=${a['888']?.band}`,
    );
    check(
      '真站漏检样本 1（显示名引流 + 无害正文）被隐藏',
      a['777']?.hidden === true && a['777']?.band === 'block',
      `band=${a['777']?.band}`,
    );
    check('纯图片短文案被隐藏为「待确认」（Jev 看不了图，只能隐藏不给动作）', a['555']?.hidden === true && a['555']?.band === 'review', `band=${a['555']?.band}`);
    check('普通推文保持可见', a['222']?.hidden === false, `band=${a['222']?.band}`);
    check('治理类新闻保持可见（新闻语境降级 + 模型否定）', a['444']?.hidden === false, `band=${a['444']?.band}`);
    check('过滤条写出了原因与概率', /色情概率|类别置信度/.test(a['111']?.bar ?? ''), (a['111']?.bar ?? '').slice(0, 80));
    check('演练模式没有真的点菜单', (probeA.actions ?? []).length === 0, JSON.stringify(probeA.actions));

    // ---- 4. Jev 线上协议 ----
    console.log('\n场景 A：Jev 请求契约');
    const jev = mock.jev;
    check('确实调用了 Jev 网关', jev.length >= 4, `${jev.length} 次`);
    check('路径为 /v1/systemone', jev.every((r) => r.url === '/v1/systemone'), jev[0]?.url);
    check('带 Authorization: Bearer <key>', jev.every((r) => r.headers.authorization === 'Bearer e2e-key'));
    check('Content-Type 为 application/json', jev.every((r) => r.headers['content-type'] === 'application/json'));
    check('Accept 为 application/json', jev.every((r) => r.headers.accept === 'application/json'));
    // 已知平台限制：User-Agent 属于受限请求头，Chrome 会丢掉脚本设置的值，
    // 所以服务端不能按 UA 识别客户端（客户端的这一行代码在 Node 下有效、在浏览器里无效）。
    check(
      'User-Agent 由浏览器接管（已记录为平台限制）',
      /Chrome/.test(jev[0]?.headers['user-agent'] ?? ''),
      jev[0]?.headers['user-agent']?.slice(0, 40),
    );
    check('模型名来自设置', jev.every((r) => r.body.model === 'jev-test'));
    const fullCalls = jev.filter((r) => Object.keys(r.body.questions ?? {}).length === 5);
    const probeCalls = jev.filter((r) => Object.keys(r.body.questions ?? {}).length === 1 && r.body.questions.junk);
    check('完整判定请求带五问（choice + 三条 noul + score）', fullCalls.length > 0 && fullCalls.every((r) => r.body.questions.adult?.type === 'noul' && r.body.questions.category?.type === 'choice' && r.body.questions.severity?.type === 'score' && r.body.questions.solicitation?.type === 'noul'), `${fullCalls.length} 次四问`);
    check('预检请求只有 junk 一问（廉价召回）', probeCalls.length > 0 && probeCalls.every((r) => Object.keys(r.body.questions).length === 1), `${probeCalls.length} 次预检`);
    check('state 里包含原推文案', jev.some((r) => String(r.body.state).includes('同城约啪')));
    check('state 单独给出 display_name（垃圾账号把引流写在显示名里的漏洞）', jev.some((r) => /display_name=.*同城约/.test(String(r.body.state))));
    check('关键词命中的推文不会走预检（省一次调用）', !probeCalls.some((r) => String(r.body.state).includes('同城约')));
    check('普通推文只走预检、不跑四问', !fullCalls.some((r) => String(r.body.state).includes('今天天气不错')) && probeCalls.some((r) => String(r.body.state).includes('今天天气不错')));
    check(
      '无关键词样本：预检命中后升级四问（bait 0.8 ≥ 0.75）',
      probeCalls.some((r) => String(r.body.state).includes('比我骚')) && fullCalls.some((r) => String(r.body.state).includes('比我骚')),
    );
    check(
      'emoji 拆字样本走的是完整四问（去符号后预筛命中了关键词，不再依赖预检）',
      fullCalls.some((r) => String(r.body.state).includes('处')),
    );
    check(
      '农场文案（bait 0.54 < 升级线）只走预检，不升级',
      probeCalls.some((r) => String(r.body.state).includes('玩的开了')) && !fullCalls.some((r) => String(r.body.state).includes('玩的开了')),
    );

    // ---- 5. SW 侧状态与图片分析 ----
    const swCdp = await swTarget();
    if (!swCdp) {
      check('找到 Service Worker 目标', false);
    } else {
      const sw = await swCdp.evaluate(SW_PROBE);
      check('找到 Service Worker 目标', Boolean(sw?.stats), 'Service Worker 运行中');
      check('Service Worker 里跑通了图片分析（OffscreenCanvas）', (sw.stats?.mediaAnalyzed ?? 0) >= 2, `mediaAnalyzed=${sw.stats?.mediaAnalyzed}`);
      check('后台统计里 block 档 ≥ 2', (sw.stats?.bands?.block ?? 0) >= 2, JSON.stringify(sw.stats?.bands));
      check(
        '后台统计按类别计数（诈骗 / 标题党 / 色情都有）',
        (sw.stats?.categories?.scam ?? 0) >= 1 && (sw.stats?.categories?.clickbait ?? 0) >= 1 && (sw.stats?.categories?.adult_solicitation ?? 0) >= 1,
        JSON.stringify(sw.stats?.categories),
      );
      check('后台统计里没有调用失败', (sw.stats?.jevErrors ?? 0) === 0 && (sw.stats?.schemaInvalid ?? 0) === 0, `errors=${sw.stats?.jevErrors} schema=${sw.stats?.schemaInvalid}`);
      const planned = (sw.audit ?? []).filter((e) => e.type === 'action_planned');
      check('审计里记录了「演练模式下本应执行」', planned.length >= 2, `${planned.length} 条`);
      check('演练计划的原因标为 dry_run', planned.every((e) => e.accountAction?.reason === 'dry_run'));
      swCdp.close();
    }

    const auditTypes = mock.audits.map((e) => e.type);
    check('审计 webhook 收到判定事件', auditTypes.includes('decision'), `${mock.audits.length} 条`);
    check('审计 webhook 收到隐藏事件', auditTypes.includes('hidden'));
    check('审计事件带来源与版本', mock.audits.every((e) => e.source === 'jev-x-filter' && typeof e.version === 'string'));
    check('页面没有脚本异常', pageA.errors.length === 0, pageA.errors.slice(0, 2).join(' | '));
    check('内容脚本没有 JS 报错（页面 context）', !pageA.errors.some((e) => String(e).includes('jevx')), pageA.errors.slice(0, 2).join(' | '));

    // ---- 6. 场景 B：武装模式 + 只分析视口内推文 ----
    console.log('\n场景 B：关闭演练 + 只分析视口内推文');
    await configure({
      ...baseSettings,
      scope: { ...baseSettings.scope, onlyVisible: true },
      action: { hide: true, autoMute: true, autoBlock: false, dryRun: false, actionDelayMs: 300, maxActionsPerHour: 20, maxActionsPerDay: 100 },
    });
    const pageB = await openPage(`${BASE}/?scenario=b`);
    let probeB = null;
    try {
      probeB = await waitFor(
        async () => {
          const p = await pageB.cdp.evaluate(PROBE);
          const hidden = Object.values(p.articles).filter((x) => x.hidden).length;
          return hidden >= 12 && p.actions.length >= 4 ? p : null;
        },
        { label: '场景 B 隐藏 3 条并执行 2 次静音' },
      );
    } catch (error) {
      probeB = await pageB.cdp.evaluate(PROBE).catch(() => ({ articles: {}, actions: [] }));
      check('场景 B 完成隐藏与静音', false, String(error.message));
    }
    const b = probeB.articles ?? {};
    const actionsB = probeB.actions ?? [];
    check('IntersectionObserver 路径生效（视口内推文被隐藏）', Object.values(b).filter((x) => x.hidden).length >= 12, `hidden=${Object.values(b).filter((x) => x.hidden).length}`);
    check(
      '自动静音点中了正确的账号（含显示名引流账号）',
      ['spammer1', 'escort4', 'JesseAlvarl3', 'stockguru88'].every((h) => actionsB.some((x) => x.kind === 'mute' && x.handle === h)),
      JSON.stringify(actionsB),
    );
    check('同一账号只动作一次（DOM 复渲染不重复执行）', actionsB.length === 4, `动作数 ${actionsB.length}`);
    check('autoBlock 关闭时不会点拉黑', !actionsB.some((x) => x.kind === 'block' || x.kind === 'block-confirmed'), JSON.stringify(actionsB));
    check('没有点到菜单里的反义项（Unmute/Unblock）', !actionsB.some((x) => String(x.kind).startsWith('un')), JSON.stringify(actionsB));
    check('隐藏的弱信号/纯图推文没有被静音（I1）', !actionsB.some((x) => x.handle === 'weak7' || x.handle === 'pic6'), JSON.stringify(actionsB));
    check('账号名/预检命中但未达 block 的样本不会被静音（I1：只有 block 档才动作）', !actionsB.some((x) => x.handle === 'yrmyzhcxvlkzpu'), JSON.stringify(actionsB));
    check('默认不因文案农场静音账号（需要显式打开开关）', !actionsB.some((x) => ['ThomasTurnyysr', 'TinaMysersyro', 'TimothyAndjqqx'].includes(x.handle)), JSON.stringify(actionsB));
    check('场景 B 页面无脚本异常', pageB.errors.length === 0, pageB.errors.slice(0, 2).join(' | '));

    const swCdp2 = await swTarget();
    if (swCdp2) {
      const swB = await swCdp2.evaluate(SW_PROBE);
      const executed = (swB.audit ?? []).filter((e) => e.type === 'action' && e.accountAction?.executed);
      check('审计里记录了真实执行的动作', executed.length >= 2, `${executed.length} 条`);
      swCdp2.close();
    }

    // ---- 6b. 场景 C：武装拉黑（确认弹窗 + 复用 testid / 反义菜单项 两个陷阱） ----
    console.log('\n场景 C：关闭演练 + 允许拉黑');
    await configure({
      ...baseSettings,
      action: { hide: true, autoMute: false, autoBlock: true, dryRun: false, actionDelayMs: 300, maxActionsPerHour: 20, maxActionsPerDay: 100 },
    });
    const pageC = await openPage(`${BASE}/?scenario=c`);
    let probeC = null;
    try {
      probeC = await waitFor(
        async () => {
          const p = await pageC.cdp.evaluate(PROBE);
          const hidden = Object.values(p.articles).filter((x) => x.hidden).length;
          const blocked = p.actions.filter((x) => x.kind === 'block').length;
          return hidden >= 12 && blocked >= 4 ? p : null;
        },
        { label: '场景 C 完成拉黑' },
      );
    } catch (error) {
      probeC = await pageC.cdp.evaluate(PROBE).catch(() => ({ articles: {}, actions: [] }));
      check('场景 C 完成拉黑', false, String(error.message));
    }
    const actionsC = probeC.actions ?? [];
    check('拉黑档位点的是拉黑而不是静音', actionsC.some((x) => x.kind === 'block') && !actionsC.some((x) => x.kind === 'mute'), JSON.stringify(actionsC));
    check('点中了拉黑后新出现的确认按钮', actionsC.some((x) => x.kind === 'block-confirmed' && x.handle === 'spammer1'), JSON.stringify(actionsC));
    check('拉黑动作没有重复执行', actionsC.filter((x) => x.kind === 'block').length === 4, `block=${actionsC.filter((x) => x.kind === 'block').length}`);
    check('没有点到菜单里的反义项（Unmute/Unblock）', !actionsC.some((x) => String(x.kind).startsWith('un')), JSON.stringify(actionsC));
    check('没有点到页面里预先存在的确认按钮（X 复用 testid 的陷阱）', !actionsC.some((x) => x.kind === 'decoy-click'), JSON.stringify(actionsC));
    check('场景 C 隐藏结果与场景 A 一致', Object.values(probeC.articles ?? {}).filter((x) => x.hidden).length >= 12, `hidden=${Object.values(probeC.articles ?? {}).filter((x) => x.hidden).length}`);
    check('场景 C 页面无脚本异常', pageC.errors.length === 0, pageC.errors.slice(0, 2).join(' | '));

    // ---- 6c. 场景 D：武装 + 「隐藏档也静音」（验证新开关的边界） ----
    console.log('\n场景 D：武装 + 隐藏档也静音');
    await configure({
      ...baseSettings,
      action: { hide: true, autoMute: true, autoBlock: false, dryRun: false, muteOnHide: true, actionDelayMs: 300, maxActionsPerHour: 20, maxActionsPerDay: 100 },
    });
    const pageD = await openPage(`${BASE}/?scenario=d`);
    const FARM_HANDLES = ['ThomasTurnyysr', 'TinaMysersyro', 'TimothyAndjqqx'];
    let probeD = null;
    try {
      probeD = await waitFor(
        async () => {
          const p = await pageD.cdp.evaluate(PROBE);
          const hidden = Object.values(p.articles).filter((x) => x.hidden).length;
          const farmMuted = FARM_HANDLES.every((h) => p.actions.some((x) => x.kind === 'mute' && x.handle === h));
          return hidden >= 9 && farmMuted ? p : null;
        },
        { label: '场景 D 完成隐藏与农场静音', timeoutMs: 45000 },
      );
    } catch (error) {
      probeD = await pageD.cdp.evaluate(PROBE).catch(() => ({ articles: {}, actions: [] }));
      check('场景 D 完成隐藏与农场静音', false, String(error.message));
    }
    const actionsD = probeD.actions ?? [];
    check('打开「隐藏档也静音」后，农场账号被静音', FARM_HANDLES.every((h) => actionsD.some((x) => x.kind === 'mute' && x.handle === h)), JSON.stringify(actionsD));
    check('「待确认」档仍然不动作（I1：预检/纯图只隐藏）', !actionsD.some((x) => ['pic6', 'yrmyzhcxvlkzpu'].includes(x.handle)), JSON.stringify(actionsD));
    check('隐藏档静音不会升级为拉黑', !actionsD.some((x) => x.kind === 'block' || x.kind === 'block-confirmed'), JSON.stringify(actionsD));
    check('标题党账号在「隐藏档也静音」下才会被静音（默认只隐藏）', actionsD.some((x) => x.kind === 'mute' && x.handle === 'buzzfeed_cn'), JSON.stringify(actionsD));
    check('场景 D 页面无脚本异常', pageD.errors.length === 0, pageD.errors.slice(0, 2).join(' | '));

    // ---- 7. 扩展页面可用性 ----
    console.log('\n扩展页面检查');
    const optionsProbe = await optionsPage.cdp.evaluate(`(() => ({
      status: document.getElementById('api-status').textContent,
      fields: document.querySelectorAll('[data-path]').length,
      presets: document.getElementById('preset').options.length,
      audit: document.getElementById('audit').textContent.slice(0, 80),
    }))()`);
    check('设置页渲染完整', optionsProbe.fields >= 40 && optionsProbe.presets === 5, `字段 ${optionsProbe.fields} / 预设 ${optionsProbe.presets}`);
    check('设置页显示模型就绪', /就绪/.test(optionsProbe.status), optionsProbe.status);

    const testResult = await optionsPage.cdp.evaluate(`(async () => {
      document.getElementById('test-text').value = '同城约啪 加电报 t.me/e2e';
      document.getElementById('test').click();
      await new Promise((r) => setTimeout(r, 2500));
      return { result: document.getElementById('test-result').textContent, note: document.getElementById('test-note').textContent };
    })()`);
    let parsedTest = null;
    try {
      parsedTest = JSON.parse(testResult.result);
    } catch {
      parsedTest = null;
    }
    check('设置页「测试连接」打通了 Jev', parsedTest?.ok === true, testResult.note);
    check('测试连接返回类型化答案', parsedTest?.answers?.adult?.noul >= 0.9 && parsedTest?.answers?.category?.choice === 'adult_solicitation', JSON.stringify(parsedTest?.answers?.category ?? null));
    check('设置页无脚本异常', optionsPage.errors.length === 0, optionsPage.errors.slice(0, 2).join(' | '));

    const popupPage = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
    await sleep(1200);
    const popupProbe = await popupPage.cdp.evaluate(`(() => ({
      mode: document.getElementById('mode').textContent,
      status: document.getElementById('status').textContent,
      cells: document.querySelectorAll('#stats div').length,
      audit: document.getElementById('audit').textContent.slice(0, 60),
      version: document.getElementById('version').textContent,
    }))()`);
    check('弹窗显示统计与模型状态', popupProbe.cells >= 6 && /jev-test|就绪/.test(popupProbe.status), `${popupProbe.status} / ${popupProbe.cells} 格`);
    check('弹窗显示当前模式（演练/武装 + 静音范围）', /演练|武装/.test(popupProbe.mode ?? ''), popupProbe.mode);
    check('弹窗无脚本异常', popupPage.errors.length === 0, popupPage.errors.slice(0, 2).join(' | '));

    // ---- 8. 黑名单导入导出（走真实消息通道） ----
    const listProbe = await optionsPage.cdp.evaluate(`(async () => {
      const send = (type, payload) => new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, resolve));
      const before = await send('JEVX_BLOCKLIST_GET');
      const imported = await send('JEVX_BLOCKLIST_IMPORT', { text: '["@imported_one","imported_two"]' });
      const exported = await send('JEVX_BLOCKLIST_EXPORT');
      const after = await send('JEVX_BLOCKLIST_GET');
      return { before: before.blocklist.entries.length, imported, exported: exported.text, after: after.blocklist.entries.map((e) => e.handle) };
    })()`);
    check('自动判定的账号已写入黑名单', listProbe.before >= 2, `导入前 ${listProbe.before} 条`);
    check('导入通道可用', listProbe.imported?.ok === true && listProbe.imported.added === 2, JSON.stringify(listProbe.imported ?? {}));
    check('导出内容包含全部账号', /imported_one/.test(listProbe.exported ?? '') && /spammer1|escort4/.test(listProbe.exported ?? ''), listProbe.after?.join(','));

    for (const page of [optionsPage, pageA, pageB, pageC, pageD, popupPage]) page.cdp.close();
    browser.close();
  } finally {
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // 等 Chrome 真的退出再删 profile，否则会撞上 ENOTEMPTY（浏览器还在往里写）。
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      chrome.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    server.close();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    fs.rmSync(EXT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n端到端结果：${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('端到端验证异常：', error);
  process.exitCode = 1;
});
