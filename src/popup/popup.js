/**
 * 弹窗：只做「看状态 + 开关 + 导出」，详细配置在设置页。
 */
import { BAND_LABEL, describeReasons } from '../sw/gate.js';

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(response ?? { ok: false, error: 'no_response' });
    });
  });
}

const els = {
  enabled: document.getElementById('enabled'),
  autoMute: document.getElementById('autoMute'),
  muteOnHide: document.getElementById('muteOnHide'),
  dryRun: document.getElementById('dryRun'),
  status: document.getElementById('status'),
  stats: document.getElementById('stats'),
  audit: document.getElementById('audit'),
  version: document.getElementById('version'),
  mode: document.getElementById('mode'),
  cats: document.getElementById('cats'),
};

/** 类别开关的顺序与文案（与 src/sw/categories.js 的 CATEGORY_GROUPS 对应）。 */
const CATEGORY_SWITCHES = [
  ['adult', '色情/引流'],
  ['scam', '诈骗/博彩'],
  ['ad_spam', '广告/导流'],
  ['clickbait', '标题党'],
  ['low_quality', '低质AI'],
  ['farm', '刷屏农场'],
];

async function refresh() {
  const state = await send('JEVX_GET_STATE');
  if (!state.ok) {
    els.status.textContent = `无法读取后台：${state.error}`;
    els.status.className = 'status warn';
    return;
  }
  els.enabled.checked = Boolean(state.settings.enabled);
  els.autoMute.checked = Boolean(state.settings.action.autoMute);
  els.muteOnHide.checked = Boolean(state.settings.action.muteOnHide);
  els.dryRun.checked = Boolean(state.settings.action.dryRun);
  els.version.textContent = `v${state.version}`;
  els.status.textContent = state.apiError
    ? `模型未就绪：${state.apiError}`
    : state.api?.ready
      ? `模型：${state.api.model}（${state.api.preset}）`
      : `配置不完整：缺少 ${(state.api?.missing ?? []).join('、')}`;
  els.status.className = `status ${state.apiError || !state.api?.ready ? 'warn' : 'ok'}`;
  const armed = !state.settings.action.dryRun;
  const mode = armed
    ? state.settings.action.autoBlock
      ? '武装：命中即静音+拉黑'
      : state.settings.action.autoMute
        ? state.settings.action.muteOnHide
          ? '武装：block + 隐藏档都静音'
          : '武装：仅 block 档静音'
        : '武装：只隐藏，不静音'
    : '演练模式：只记录，不执行账号动作';
  els.mode.textContent = mode;
  els.mode.className = `status ${armed ? 'ok' : ''}`;

  // 类别开关
  els.cats.textContent = '';
  for (const [key, label] of CATEGORY_SWITCHES) {
    const wrap = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.settings.categories?.[key]?.enabled !== false;
    box.addEventListener('change', async () => {
      await send('JEVX_SET_SETTINGS', { patch: { categories: { [key]: { enabled: box.checked } } } });
      await refresh();
    });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(box, span);
    els.cats.appendChild(wrap);
  }

  const s = state.stats ?? {};
  const bands = s.bands ?? {};
  const cells = [
    ['已过滤', (bands.block ?? 0) + (bands.hide ?? 0) + (bands.review ?? 0)],
    ['已放行', bands.ignore ?? 0],
    ['模型调用', s.jevCalls ?? 0],
    ['预检命中', s.triageHits ?? 0],
    ['待动作', bands.block ?? 0],
    ['黑名单', state.blocklist?.total ?? 0],
  ];
  els.stats.textContent = '';
  for (const [label, value] of cells) {
    const box = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const span = document.createElement('span');
    span.textContent = label;
    box.append(strong, span);
    els.stats.appendChild(box);
  }

  els.audit.textContent =
    (state.audit ?? [])
      .slice(-6)
      .reverse()
      .map((event) => {
        const time = new Date(event.ts).toLocaleTimeString();
        const who = event.tweet?.handle ? `@${event.tweet.handle}` : '';
        const band = event.decision?.band ? BAND_LABEL[event.decision.band] ?? event.decision.band : event.type;
        const reasons = event.decision?.reasons?.length ? `（${describeReasons(event.decision.reasons).join('，')}）` : '';
        return `${time} ${who} ${band}${reasons}`;
      })
      .join('\n') || '（暂无事件）';
}

els.enabled.addEventListener('change', async () => {
  await send('JEVX_SET_SETTINGS', { patch: { enabled: els.enabled.checked } });
  await refresh();
});

els.autoMute.addEventListener('change', async () => {
  await send('JEVX_SET_SETTINGS', { patch: { action: { autoMute: els.autoMute.checked } } });
  await refresh();
});

els.muteOnHide.addEventListener('change', async () => {
  await send('JEVX_SET_SETTINGS', { patch: { action: { muteOnHide: els.muteOnHide.checked } } });
  await refresh();
});

els.dryRun.addEventListener('change', async () => {
  await send('JEVX_SET_SETTINGS', { patch: { action: { dryRun: els.dryRun.checked } } });
  await refresh();
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('export').addEventListener('click', async () => {
  const result = await send('JEVX_BLOCKLIST_EXPORT');
  if (!result.ok) return;
  const blob = new Blob([result.text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `jevx-blocklist-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  await send('JEVX_CLEAR_CACHE');
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 3000);
