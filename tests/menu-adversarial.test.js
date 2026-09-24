/**
 * 独立对抗性验证：菜单自动化修复（task-6，针对 task-5 的 `menu_item_not_found:mute`）。
 *
 * 这份文件**刻意不复述** Lead 在 `tests/action-menu.test.js` 里的用例，而是自带一套最小 DOM 打桩，
 * 从「会不会点反 / 会不会点到残留节点 / 会不会瞎猜」三个对抗角度驱动
 * `src/content/selectors.js` 的 `findMenuItem` / `matchMenuLabel` / `getOpenMenu` / `pickFreshMenu` /
 * `clickElement`。只读 src/，不修改任何实现文件。
 *
 * 打桩说明：selectors.js 是传统脚本，只在函数内部读 `document`，所以这里用普通对象模拟
 * `querySelectorAll` / `querySelector` / `matches` / `getAttribute` / `getBoundingClientRect` /
 * `isConnected` / `click` / `dispatchEvent`，以及一个扁平的「文档序」节点表。
 *
 * 缺陷记录约定：最初发现的缺口写成 `{ todo: true }` 用例（node:test 里 todo 失败不会让
 * `node --test tests/` 变红，但会出现在 todo 计数里）。**这些缺口已由 Lead 在实现里修掉**，
 * 文件末尾的「缺口 1–7」现在是硬断言（回归守卫），不再是 todo。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------- 最小 DOM 打桩 ------------------------------- */

/** 只支持这份测试需要的选择器形态：`tag`、`[attr="v"]`、`tag[attr="v"]`、逗号分隔。 */
function matchesSimple(el, sel) {
  const m = /^([a-zA-Z]+)?(?:\[([a-zA-Z-]+)=["']([^"']*)["']\])?$/.exec(String(sel).trim());
  if (!m) return false;
  const [, tag, attr, value] = m;
  if (!tag && !attr) return false;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (attr && el.getAttribute(attr) !== value) return false;
  return true;
}

function matchesSel(el, sel) {
  return String(sel).split(',').some((part) => matchesSimple(el, part));
}

function walkDesc(node, fn) {
  for (const child of node.children ?? []) {
    fn(child);
    walkDesc(child, fn);
  }
}

/**
 * 假元素。`width/height` 为 0 表示「没有盒子」（等价于 display:none 的祖先让 rect 归零）。
 */
function makeEl({
  tag = 'div',
  testid = null,
  role = null,
  text = '',
  aria = null,
  width = 100,
  height = 20,
  connected = true,
  children = [],
  throwOnRect = false,
} = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    isConnected: connected,
    textContent: text,
    clicked: 0,
    focused: false,
    dispatched: [],
    _attrs: {},
    getBoundingClientRect() {
      if (throwOnRect) throw new Error('layout unavailable');
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    },
    getAttribute(name) {
      return name in el._attrs ? el._attrs[name] : null;
    },
    hasAttribute(name) {
      return name in el._attrs;
    },
    matches(sel) {
      return matchesSel(el, sel);
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const out = [];
      walkDesc(el, (node) => {
        if (matchesSel(node, sel)) out.push(node);
      });
      return out;
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (matchesSel(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    click() {
      el.clicked += 1;
      if (el.throwOnClick) throw new Error('click failed');
    },
    focus() {
      el.focused = true;
    },
    dispatchEvent(event) {
      el.dispatched.push(event.type);
      return true;
    },
  };
  if (testid) el._attrs['data-testid'] = testid;
  if (role) el._attrs.role = role;
  if (aria) el._attrs['aria-label'] = aria;
  for (const child of children) el.appendChild(child);
  return el;
}

/** X 的浮层菜单节点。 */
function menuEl(children = [], opts = {}) {
  return makeEl({ tag: 'div', testid: 'Dropdown', children, ...opts });
}

/** 菜单项（X 里是 `[role="menuitem"]`）。 */
function itemEl(text, opts = {}) {
  return makeEl({ tag: 'div', role: 'menuitem', text, ...opts });
}

/**
 * 安装假 document。按「文档序」扁平化：每个顶层节点先于其后代，顺序即 DOM 顺序
 * （selectors.js 的 `collectMenus` 取最后一层、兜底扫描取文档序，都依赖它）。
 */
function setDoc(topNodes = []) {
  const flat = [];
  for (const node of topNodes) {
    flat.push(node);
    walkDesc(node, (child) => flat.push(child));
  }
  globalThis.document = {
    querySelectorAll(sel) {
      return flat.filter((el) => matchesSel(el, sel));
    },
    querySelector(sel) {
      return flat.find((el) => matchesSel(el, sel)) ?? null;
    },
  };
  return flat;
}

await import('../src/content/selectors.js');
const S = globalThis.JevXSelectors;

/* ---------------------------- 自选多语言样本（不照抄 Lead 的表） ---------------------------- */

/** 静音 / 取消静音：10 种语言，样本措辞与 Lead 的表不同（带 @ 后缀、不同动词形态）。 */
const MUTE_PAIRS = [
  ['en', 'Mute @spammer', 'Unmute @spammer'],
  ['ja', 'ミュート @spammer', 'ミュート解除 @spammer'],
  ['ko', '음소거 @spammer', '음소거 해제 @spammer'],
  ['ru', 'Заглушить @spammer', 'Разглушить @spammer'],
  ['ar', 'كتم @spammer', 'إلغاء كتم @spammer'],
  ['th', 'ปิดเสียง @spammer', 'เปิดเสียง @spammer'],
  ['vi', 'Tắt tiếng @spammer', 'Bật tiếng @spammer'],
  ['tr', 'Sessize al @spammer', 'Sessizden çıkar @spammer'],
  ['es', 'Silenciar @spammer', 'Dejar de silenciar @spammer'],
  ['id', 'Bisukan @spammer', 'Aktifkan @spammer'],
];

/** 拉黑 / 取消拉黑：7 种语言。 */
const BLOCK_PAIRS = [
  ['en', 'Block @spammer', 'Unblock @spammer'],
  ['ja', 'ブロック @spammer', 'ブロック解除 @spammer'],
  ['ko', '차단 @spammer', '차단 해제 @spammer'],
  ['ru', 'Заблокировать @spammer', 'Разблокировать @spammer'],
  ['ar', 'حظر @spammer', 'إلغاء الحظر @spammer'],
  ['fr', 'Bloquer @spammer', 'Débloquer @spammer'],
  ['de', 'Blockieren @spammer', 'Blockierung aufheben @spammer'],
];

/* ------------------------------- 前置自检 ------------------------------- */

test('selectors.js 作为传统脚本可在 Node 里加载（打桩接口齐备）', () => {
  for (const name of ['findMenuItem', 'matchMenuLabel', 'getOpenMenu', 'pickFreshMenu', 'clickElement', 'isRendered', 'collectMenus']) {
    assert.equal(typeof S?.[name], 'function', `缺少 ${name}`);
  }
});

/* ====================== 对抗 1：反义项排在目标项之前 ====================== */

test('对抗：菜单里反义项排在目标项之前时，必须选中目标项（静音 10 语种）', () => {
  for (const [lang, targetLabel, antiLabel] of MUTE_PAIRS) {
    const anti = itemEl(antiLabel);
    const target = itemEl(targetLabel);
    setDoc([menuEl([anti, target])]); // 反义项在前
    const picked = S.findMenuItem('mute');
    assert.equal(picked, target, `${lang}: 应选目标项「${targetLabel}」，实际 ${picked?.textContent ?? picked}`);
    assert.notEqual(picked, anti, `${lang}: 绝不能点反义项`);
    // 文案判定层面同样必须先排除反义项
    assert.equal(S.matchMenuLabel('mute', antiLabel), false, `${lang}: mute 不该命中反义文案`);
    assert.equal(S.matchMenuLabel('unmute', antiLabel), true, `${lang}: 反义文案应归 unmute`);
  }
});

test('对抗：菜单里反义项排在目标项之前时，必须选中目标项（拉黑 7 语种）', () => {
  for (const [lang, targetLabel, antiLabel] of BLOCK_PAIRS) {
    const anti = itemEl(antiLabel);
    const target = itemEl(targetLabel);
    setDoc([menuEl([anti, target])]);
    const picked = S.findMenuItem('block');
    assert.equal(picked, target, `${lang}: 应选目标项「${targetLabel}」`);
    assert.equal(S.matchMenuLabel('block', antiLabel), false, `${lang}: block 不该命中反义文案`);
  }
});

test('对抗：「取消静音」无论排第几、前面有几个反义项，都不会被当成静音（多语种乱序）', () => {
  const antiLabels = ['取消静音 @spammer', 'ミュート解除 @spammer', 'Разглушить @spammer', 'Unmute @spammer'];
  const antiItems = antiLabels.map((label) => itemEl(label));
  const target = itemEl('음소거 @spammer');
  setDoc([menuEl([...antiItems, target])]);
  assert.equal(S.findMenuItem('mute'), target);
  for (const label of antiLabels) assert.equal(S.matchMenuLabel('mute', label), false, label);
});

/* ====================== 对抗 2：残留 / 不可见菜单 ====================== */

test('对抗：不可见的残留菜单排在真实菜单之前，不得选中残留里的项', () => {
  const staleItem = itemEl('静音 stale');
  const stale = menuEl([staleItem], { width: 0, height: 0 }); // display:none → rect 归零
  const realItem = itemEl('静音 @spammer');
  const real = menuEl([realItem]);
  setDoc([stale, real]); // 残留在前、真实在后

  assert.equal(S.isRendered(stale), false, '残留节点没有盒子');
  assert.equal(S.getOpenMenu(), real, 'getOpenMenu 必须跳过不可见菜单');
  assert.equal(S.findMenuItem('mute'), realItem, '不得选中残留节点里的项');
});

test('对抗：残留菜单里的项是反义项、真实菜单里是目标项时，必须选真实目标项', () => {
  const stale = menuEl([itemEl('取消静音 stale')], { width: 0, height: 0 });
  const realItem = itemEl('静音 @spammer');
  const real = menuEl([realItem]);
  setDoc([stale, real]);
  const picked = S.findMenuItem('mute');
  assert.equal(picked, realItem);
  assert.equal(S.matchMenuLabel('mute', picked.textContent), true, '选中的必须真的是静音项');
});

test('对抗：pickFreshMenu 只认点击后新出现的菜单，不认 before 快照里的残留节点', () => {
  const stale = menuEl([itemEl('静音 stale')]);
  const fresh = menuEl([itemEl('静音 fresh')]);
  setDoc([stale, fresh]);
  const picked = S.pickFreshMenu([stale]);
  assert.equal(picked, fresh, '快照里的残留节点必须被排除');
});

test('对抗：多个可见菜单时，findMenuItem({menu}) 只在传入的那个菜单里优先找', () => {
  const stale = menuEl([itemEl('静音 stale')]);
  const realItem = itemEl('静音 real');
  const real = menuEl([realItem]);
  setDoc([stale, real]);
  assert.equal(S.findMenuItem('mute', { menu: real }), realItem);
});

/* ====================== 对抗 3：空 / 只有反义 / 只有无关 → null ====================== */

test('对抗：空菜单 / 只有反义项 / 只有无关项 / 没有菜单 → 一律 null，绝不猜点', () => {
  setDoc([]);
  assert.equal(S.findMenuItem('mute'), null, '页面上根本没有菜单');
  assert.equal(S.findMenuItem('block'), null);

  setDoc([menuEl([])]);
  assert.equal(S.findMenuItem('mute'), null, '空菜单');

  setDoc([menuEl([itemEl('取消静音 @spammer')])]);
  assert.equal(S.findMenuItem('mute'), null, '只有反义项');
  setDoc([menuEl([itemEl('取消屏蔽 @spammer')])]);
  assert.equal(S.findMenuItem('block'), null, '只有反义项（拉黑）');

  setDoc([menuEl([itemEl('关注 @spammer'), itemEl('添加到列表'), itemEl('举报帖子'), itemEl('Copy link')])]);
  assert.equal(S.findMenuItem('mute'), null, '只有无关项');
  assert.equal(S.findMenuItem('block'), null, '只有无关项（拉黑）');

  // 只有按钮形态的无关项（getMenuItems 会把 menu 内的 button 也算进来）
  setDoc([menuEl([makeEl({ tag: 'button', text: '查看更多' })])]);
  assert.equal(S.findMenuItem('mute'), null, '只有无关按钮');
});

test('对抗：无关文案不会被词根误命中（含 mute/block 词根但非独立单词的普通词）', () => {
  // 注意：这里刻意不包含「Mute notifications」「Block party」这类**含独立单词**的文案 ——
  // 它们命中是词表匹配的预期行为（X 菜单里也不会有这种项），算不上缺陷。
  for (const label of ['commuter 乘车人', 'blockchain news', 'unblockable', 'commute 通勤', 'blockade zone']) {
    assert.equal(S.matchMenuLabel('mute', label), false, `mute 不该命中：${label}`);
    assert.equal(S.matchMenuLabel('block', label), false, `block 不该命中：${label}`);
  }
});

/* ====================== 对抗 4：testid 正常路径必须正确 ====================== */

test('对抗：testid 与文案一致时必须正确命中（mute/muteLink/block/blockLink）', () => {
  const muteItem = itemEl('Mute @spammer', { testid: 'mute' });
  setDoc([menuEl([muteItem])]);
  assert.equal(S.findMenuItem('mute'), muteItem);

  const muteLink = itemEl('静音 @spammer', { testid: 'muteLink' });
  setDoc([menuEl([muteLink])]);
  assert.equal(S.findMenuItem('mute'), muteLink);

  const blockItem = itemEl('Block @spammer', { testid: 'block' });
  setDoc([menuEl([blockItem])]);
  assert.equal(S.findMenuItem('block'), blockItem);

  const blockLink = itemEl('屏蔽 @spammer', { testid: 'blockLink' });
  setDoc([menuEl([blockLink])]);
  assert.equal(S.findMenuItem('block'), blockLink);
});

test('对抗：反义 testid 不会被当成目标动作（unmute/unblock 项）', () => {
  const unmute = itemEl('Unmute @spammer', { testid: 'unmute' });
  setDoc([menuEl([unmute])]);
  assert.equal(S.findMenuItem('mute'), null, 'unmute 项不是静音项');
  assert.equal(S.findMenuItem('unmute'), unmute);

  const unblock = itemEl('Unblock @spammer', { testid: 'unblock' });
  setDoc([menuEl([unblock])]);
  assert.equal(S.findMenuItem('block'), null, 'unblock 项不是拉黑项');
  assert.equal(S.findMenuItem('unblock'), unblock);
});

test('对抗：testid 与文案方向冲突的项，两个方向都不选（宁可失败，也不 50% 点反）', () => {
  // Lead 裁定（覆盖原先「冲突里选文案方向」的写法）：`data-testid="mute"` + 文案「取消静音 @spammer」
  // 属于自相矛盾的项 —— 无法判断点下去到底执行哪个动作，所以两个方向都跳过。
  const item = itemEl('取消静音 @spammer', { testid: 'mute' });
  setDoc([menuEl([item])]);
  assert.equal(S.findMenuItem('unmute'), null, '冲突项不做「猜方向」');
  assert.equal(S.findMenuItem('mute'), null);
});

/* ====================== 对抗 5：clickElement 的健壮性 ====================== */

test('对抗：clickElement 空值/抛错都不抛异常，点击计数正确', () => {
  assert.equal(S.clickElement(null), false, 'null 必须安全返回 false');
  assert.equal(S.clickElement(undefined), false);

  const el = itemEl('静音 @spammer');
  assert.equal(S.clickElement(el), true);
  assert.equal(el.clicked, 1, '默认走原生 .click()');
  assert.equal(el.focused, true);

  const broken = itemEl('静音 @spammer');
  broken.throwOnClick = true;
  assert.equal(S.clickElement(broken), false, 'click 抛错时返回 false，不向上抛');
});

test('对抗：pointer 模式派发完整指针序列；native:false 时不补 click', () => {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const savedMouse = globalThis.MouseEvent;
  const savedPointer = globalThis.PointerEvent;
  globalThis.MouseEvent = FakeEvent;
  globalThis.PointerEvent = FakeEvent;
  try {
    const el = itemEl('静音 @spammer');
    assert.equal(S.clickElement(el, { pointer: true }), true);
    assert.deepEqual(el.dispatched, ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
    assert.equal(el.clicked, 1, 'pointer 模式默认仍补一次 click');

    const noNative = itemEl('静音 @spammer');
    assert.equal(S.clickElement(noNative, { pointer: true, native: false }), true);
    assert.deepEqual(noNative.dispatched, ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
    assert.equal(noNative.clicked, 0, 'native:false 时不得补 click（否则会「mousedown 打开 + click 关闭」）');
  } finally {
    globalThis.MouseEvent = savedMouse;
    globalThis.PointerEvent = savedPointer;
  }
});

test('对抗：isRendered 对零盒子 / 抛错 / 无接口的元素都返回 false（绝不误判为可见）', () => {
  assert.equal(S.isRendered(makeEl({ width: 0, height: 0 })), false);
  assert.equal(S.isRendered(makeEl({ throwOnRect: true })), false);
  assert.equal(S.isRendered({}), false);
  assert.equal(S.isRendered(null), false);
  assert.equal(S.isRendered(makeEl({ width: 1, height: 1 })), true);
});

/* ====================== 对抗 6：多语言正反例（自选样本） ====================== */

test('对抗：自选多语言样本——静音正例/反例（10 语种，18 条断言组）', () => {
  for (const [lang, positive, anti] of MUTE_PAIRS) {
    assert.equal(S.matchMenuLabel('mute', positive), true, `${lang} 正例应命中 mute：${positive}`);
    assert.equal(S.matchMenuLabel('unmute', positive), false, `${lang} 正例不该命中 unmute`);
    assert.equal(S.matchMenuLabel('unmute', anti), true, `${lang} 反例应命中 unmute：${anti}`);
    assert.equal(S.matchMenuLabel('mute', anti), false, `${lang} 反例绝不能被当成 mute（点反）：${anti}`);
  }
});

test('对抗：自选多语言样本——拉黑正例/反例（7 语种）', () => {
  for (const [lang, positive, anti] of BLOCK_PAIRS) {
    assert.equal(S.matchMenuLabel('block', positive), true, `${lang} 正例应命中 block：${positive}`);
    assert.equal(S.matchMenuLabel('unblock', positive), false, `${lang} 正例不该命中 unblock`);
    assert.equal(S.matchMenuLabel('unblock', anti), true, `${lang} 反例应命中 unblock：${anti}`);
    assert.equal(S.matchMenuLabel('block', anti), false, `${lang} 反例绝不能被当成 block（点反）：${anti}`);
  }
});

test('对抗：图标 / bidi 控制符 / 引号包裹不改变多语言判定', () => {
  assert.equal(S.matchMenuLabel('mute', '🔇 静音 @spammer'), true);
  assert.equal(S.matchMenuLabel('mute', '\u200f ミュート @spammer'), true);
  assert.equal(S.matchMenuLabel('mute', '«Заглушить @spammer»'), true);
  assert.equal(S.matchMenuLabel('mute', '🔊 Unmute @spammer'), false);
  assert.equal(S.matchMenuLabel('block', '⛔ ブロック @spammer'), true);
  assert.equal(S.matchMenuLabel('block', '⛔ ブロック解除 @spammer'), false);
});

/* ========== 独立验证发现的缺口（Lead 已在实现里修掉，这里转成硬断言守住） ==========
 * 2026-02 修复：`findMenuItemIn` 增加「testid 与文案方向交叉校验」（isConflictingItem）、
 * 反义侧改为「否定词 + 词根」结构（NEGATION_MARKER）、`getOpenMenu`/`pickFreshMenu` 不再退回不可见残留节点、
 * 且支持按目标 handle 过滤文案里写了别的账号的项（labelHandleMismatch）。
 */

test('缺口 1：testid=mute 但文案是「取消静音」时不得按 testid 直接点击（应返回 null）', () => {
  // 最小复现：菜单里只有一个 <div role="menuitem" data-testid="mute">取消静音 @spammer</div>
  // 期望：null（点它等于执行 unmute，是「点反」，比失败更糟）
  const conflicting = itemEl('取消静音 @spammer', { testid: 'mute' });
  setDoc([menuEl([conflicting])]);
  assert.equal(S.findMenuItem('mute'), null, 'testid 与文案方向冲突时必须宁可不点');
});

test('缺口 2：testid 冲突项不得压过同菜单里的干净项（应选干净项）', () => {
  const conflicting = itemEl('取消静音 @spammer', { testid: 'mute' });
  const clean = itemEl('静音 @spammer');
  setDoc([menuEl([conflicting, clean])]);
  assert.equal(S.findMenuItem('mute'), clean, '同菜单里存在干净项时，不该选冲突项');
});

test('缺口 3：testid=unmute + 文案「静音」双向冲突时不得返回该元素', () => {
  const conflicting = itemEl('静音 @spammer', { testid: 'unmute' });
  setDoc([menuEl([conflicting])]);
  assert.equal(S.findMenuItem('mute'), null, 'testid=unmute 的项不该被当作静音项');
  assert.equal(S.findMenuItem('unmute'), null, '文案=静音的项不该被当作取消静音项');
});

test('缺口 4：若干语言的「取消静音 / 取消拉黑」未覆盖，会被判成目标动作（点反）', () => {
  const dangerous = [
    ['mute', 'Deixar de silenciar @spammer'],
    ['mute', 'Deixa de silenciar @spammer'],
    ['mute', 'Wyłącz wyciszenie @spammer'],
    ['mute', 'Stummschaltung aufheben @spammer'],
    ['block', 'Deixar de bloquear @spammer'],
    ['block', 'Odblokować @spammer'],
    ['block', 'Désactiver le blocage @spammer'],
  ];
  for (const [action, label] of dangerous) {
    assert.equal(S.matchMenuLabel(action, label), false, `${action} 不该命中反义文案：${label}`);
  }
});

test('缺口 5（残留菜单）：没有新菜单出现时 pickFreshMenu 不得退回不可见残留节点', () => {
  // Lead 裁定：**可见**的既有菜单是可信的（X 会复用同一个 Dropdown 节点，可见=刚刚打开），
  // 但**不可见**的残留节点绝不可信——它的菜单项还绑着上一个账号的处理函数。
  const staleHidden = menuEl([itemEl('静音 stale')], { width: 0, height: 0 });
  setDoc([staleHidden]);
  assert.equal(S.pickFreshMenu([staleHidden]), null, '没有新菜单时应返回 null，而不是退回不可见残留节点');

  const staleVisible = menuEl([itemEl('静音 stale')]);
  setDoc([staleVisible]);
  assert.equal(S.pickFreshMenu([staleVisible]), staleVisible, '可见的既有菜单视为「刚被打开」，应被接受');
});

test('缺口 6（残留菜单）：页面上只有不可见菜单时，findMenuItem 必须返回 null', () => {
  const hiddenItem = itemEl('静音 hidden', { width: 0, height: 0 });
  setDoc([menuEl([hiddenItem], { width: 0, height: 0 })]);
  assert.equal(S.findMenuItem('mute'), null, '没有可见菜单时宁可不点');
});

test('缺口 7（静音错人）：传入目标 handle 时，文案指向别的账号的项必须被跳过', () => {
  // 残留菜单里写着 @stale_ghost，而这次要静音的是 spammer1 → 绝不能点（否则静音错人）
  const otherAccount = itemEl('Mute @stale_ghost');
  setDoc([menuEl([otherAccount])]);
  assert.equal(S.findMenuItem('mute', { handle: 'spammer1' }), null, '不能静音别的账号');

  // 文案里没写 handle（本地化/简写）时不受这条限制
  const generic = itemEl('静音');
  setDoc([menuEl([generic])]);
  assert.equal(S.findMenuItem('mute', { handle: 'spammer1' }), generic, '无 handle 的项照常命中');

  // 写的是目标 handle（大小写不敏感）→ 命中
  const mine = itemEl('Mute @Spammer1');
  setDoc([menuEl([mine])]);
  assert.equal(S.findMenuItem('mute', { handle: 'spammer1' }), mine, '目标 handle 大小写不敏感');

  // 同一菜单里既有别人的项又有自己的项 → 选自己的
  const mine2 = itemEl('静音 @spammer1');
  setDoc([menuEl([otherAccount, mine2])]);
  assert.equal(S.findMenuItem('mute', { handle: 'spammer1' }), mine2, '同菜单里应选自己的项');
});
