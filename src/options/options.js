/**
 * 设置页逻辑。
 *
 * 字段绑定是「声明式」的：HTML 上用 data-path="thresholds.blockNoul" 标注，
 * 这里统一读取/写回，新增配置项不需要动 JS。数组类型（白名单）按行/逗号切分。
 */
import { API_PRESETS, DEFAULT_SETTINGS } from '../sw/settings.js';
import { BAND_LABEL, describeReasons as describeGateReasons } from '../sw/gate.js';
import { describeReasons as describePrefilterReasons } from '../sw/prefilter.js';

const fields = [...document.querySelectorAll('[data-path]')];

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(response ?? { ok: false, error: 'no_response' });
    });
  });
}

function setByPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function getByPath(source, path) {
  return path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), source);
}

function readField(el) {
  const path = el.dataset.path;
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.array === '1' || path.endsWith('handles') || path.endsWith('keywords')) {
    return String(el.value)
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (el.type === 'number') {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return el.value;
}

function fillFields(settings) {
  for (const el of fields) {
    const value = getByPath(settings, el.dataset.path);
    if (value === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (Array.isArray(value)) el.value = value.join('\n');
    else el.value = value ?? '';
  }
}

function collectPatch() {
  const patch = {};
  for (const el of fields) {
    const value = readField(el);
    if (value === undefined) continue;
    setByPath(patch, el.dataset.path, value);
  }
  return patch;
}

function pill(el, text, kind = '') {
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
  el.hidden = false;
}

function note(el, text, kind = '') {
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? '#1a7f37' : '';
}

function renderPresetOptions() {
  const select = document.getElementById('preset');
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(API_PRESETS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function renderStats(state) {
  const box = document.getElementById('stats');
  const s = state.stats ?? {};
  const bands = s.bands ?? {};
  const rows = [
    ['本会话判定数', s.decisions ?? 0],
    ['模型调用', s.jevCalls ?? 0],
    ['预检调用（单问）', s.triageProbes ?? 0],
    ['预检命中', s.triageHits ?? 0],
    ['升级为四问', s.triageEscalated ?? 0],
    ['缓存命中', s.cacheHits ?? 0],
    ['预筛跳过（0 请求）', s.skips ?? 0],
    ['隐藏（高置信度）', bands.block ?? 0],
    ['隐藏', bands.hide ?? 0],
    ['待确认', bands.review ?? 0],
    ['放行', bands.ignore ?? 0],
    ['图片分析', s.mediaAnalyzed ?? 0],
    ['调用失败', s.jevErrors ?? 0],
    ['回答不合规', s.schemaInvalid ?? 0],
    ['黑名单账号', state.blocklist?.total ?? 0],
    ['累计判定', state.cumulative?.decisions ?? 0],
    ['累计动作', state.cumulative?.actions ?? 0],
  ];
  const byCategory = s.categories ?? {};
  for (const [cat, count] of Object.entries(byCategory)) {
    if (!count) continue;
    rows.push([`类别 · ${cat}`, count]);
  }
  box.innerHTML = '';
  for (const [label, value] of rows) {
    const cell = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    const span = document.createElement('span');
    span.textContent = label;
    cell.append(strong, span);
    box.appendChild(cell);
  }
  const status = document.getElementById('api-status');
  if (state.apiError) pill(status, `模型未就绪：${state.apiError}`, 'warn');
  else if (state.api?.ready) pill(status, `模型就绪 · ${state.api.preset} · ${state.api.model}`, 'ok');
  else pill(status, `配置不完整：缺少 ${(state.api?.missing ?? []).join('、') || '未知'}`, 'warn');
  document.getElementById('api-error').hidden = true;
}

function renderAudit(events) {
  const pre = document.getElementById('audit');
  const lines = (events ?? []).slice(-40).reverse().map((event) => {
    const time = new Date(event.ts).toLocaleTimeString();
    const who = event.tweet?.handle ? `@${event.tweet.handle}` : '';
    const band = event.decision?.band ? BAND_LABEL[event.decision.band] ?? event.decision.band : '';
    const reasons = event.decision?.reasons?.length ? ` · ${describeGateReasons(event.decision.reasons).join('，')}` : '';
    const action = event.accountAction?.kind && event.accountAction.kind !== 'none'
      ? ` · 动作=${event.accountAction.kind}(${event.accountAction.execute ? '已执行' : event.accountAction.reason})`
      : '';
    return `${time} ${event.type} ${who} ${band}${reasons}${action}`;
  });
  pre.textContent = lines.join('\n') || '（暂无事件）';
}

function renderBlocklist(state) {
  pill(
    document.getElementById('blocklist-stats'),
    `账号 ${state.blocklist?.total ?? 0} · 白名单 ${state.blocklist?.whitelistHandles ?? 0} 个账号 / ${state.blocklist?.whitelistKeywords ?? 0} 个关键词`,
  );
  const table = document.getElementById('blocklist-table');
  const list = state.blocklistFull?.entries ?? [];
  table.textContent = '';
  if (list.length === 0) {
    const caption = document.createElement('caption');
    caption.textContent = '黑名单为空';
    table.appendChild(caption);
    return;
  }
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['账号', '档位', '色情概率', '来源', '命中次数', '原因', '操作']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const entry of list.slice(0, 200)) {
    const row = document.createElement('tr');
    const cells = [
      `@${entry.handle}`,
      entry.bestBand ?? '',
      entry.bestAdult === null || entry.bestAdult === undefined ? '' : `${Math.round(entry.bestAdult * 100)}%`,
      entry.source ?? '',
      String(entry.hits ?? 1),
      describeGateReasons(entry.reasons ?? []).join('，') || describePrefilterReasons(entry.reasons ?? []).join('，'),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      row.appendChild(td);
    }
    const tdAction = document.createElement('td');
    const remove = document.createElement('button');
    remove.textContent = '移出';
    remove.addEventListener('click', async () => {
      await send('JEVX_BLOCKLIST_REMOVE', { handle: entry.handle });
      await refresh();
    });
    tdAction.appendChild(remove);
    row.appendChild(tdAction);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
}

async function refresh() {
  const state = await send('JEVX_GET_STATE');
  if (!state.ok) return;
  fillFields(state.settings);
  renderStats(state);
  renderAudit(state.audit);
  pill(
    document.getElementById('blocklist-stats'),
    `账号 ${state.blocklist?.total ?? 0} · 白名单 ${state.blocklist?.whitelistHandles ?? 0} 个账号 / ${state.blocklist?.whitelistKeywords ?? 0} 个关键词`,
  );
  const full = await send('JEVX_BLOCKLIST_GET');
  if (full.ok) renderBlocklist({ ...state, blocklistFull: full.blocklist });
  return state;
}

/* --------------------------------- 事件绑定 --------------------------------- */

renderPresetOptions();

document.getElementById('save').addEventListener('click', async () => {
  const result = await send('JEVX_SET_SETTINGS', { patch: collectPatch() });
  note(document.getElementById('save-note'), result.ok ? '已保存' : `保存失败：${result.error}`, result.ok ? 'ok' : 'error');
  await refresh();
});

document.getElementById('reload').addEventListener('click', () => refresh());

document.getElementById('test').addEventListener('click', async () => {
  const button = document.getElementById('test');
  button.disabled = true;
  note(document.getElementById('test-note'), '调用中…');
  const text = document.getElementById('test-text').value;
  const result = await send('JEVX_TEST_CONNECTION', { text });
  const pre = document.getElementById('test-result');
  pre.hidden = false;
  pre.textContent = JSON.stringify(result, null, 2);
  note(
    document.getElementById('test-note'),
    result.ok ? `成功 · ${result.latencyMs}ms` : `失败：${result.error}`,
    result.ok ? 'ok' : 'error',
  );
  button.disabled = false;
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const result = await send('JEVX_CLEAR_CACHE');
  note(document.getElementById('cache-note'), result.ok ? '缓存已清空' : `失败：${result.error}`, result.ok ? 'ok' : 'error');
  await refresh();
});

document.getElementById('export').addEventListener('click', async () => {
  const result = await send('JEVX_BLOCKLIST_EXPORT');
  const pre = document.getElementById('export-out');
  pre.hidden = false;
  pre.textContent = result.text ?? '';
});

document.getElementById('download').addEventListener('click', async () => {
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

document.getElementById('import-btn').addEventListener('click', async () => {
  const text = document.getElementById('import').value;
  if (!text.trim()) {
    note(document.getElementById('import-note'), '没有可导入的内容', 'error');
    return;
  }
  const result = await send('JEVX_BLOCKLIST_IMPORT', { text });
  note(
    document.getElementById('import-note'),
    result.ok
      ? `格式=${result.format} 新增=${result.added} 更新=${result.updated} 跳过=${result.errors?.length ?? 0}`
      : `失败：${result.error}`,
    result.ok ? 'ok' : 'error',
  );
  document.getElementById('import').value = '';
  await refresh();
});

document.getElementById('clear-list').addEventListener('click', async () => {
  const result = await send('JEVX_BLOCKLIST_CLEAR');
  note(document.getElementById('import-note'), result.ok ? '黑名单已清空' : `失败：${result.error}`, result.ok ? 'ok' : 'error');
  await refresh();
});

document.getElementById('open-audit').addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('audit').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

fillFields(DEFAULT_SETTINGS);
void refresh();
setInterval(() => void refresh(), 5000);
