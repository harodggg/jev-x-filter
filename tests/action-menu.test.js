/**
 * 菜单项识别（`src/content/selectors.js`）的纯逻辑单测。
 *
 * 背景：真站上出现过 `自动动作失败：menu_item_not_found:mute`。静音菜单项在多数 X 构建里
 * **没有 data-testid**（拉黑有），只能按文案匹配；而文案会随界面语言变化、前面还可能带图标/双向控制符。
 * 这里用表驱动把「必须命中」「必须不命中（尤其是反义项）」钉死 —— 点反了（静音 → 取消静音）
 * 比失败更糟，所以反义项优先判断是硬约束。
 *
 * selectors.js 是传统脚本（挂在 globalThis 上），在 Node 里可以直接 import：它只在函数内部碰 document。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/selectors.js');

const S = globalThis.JevXSelectors;

test('selectors.js 作为传统脚本可在 Node 里加载', () => {
  assert.equal(typeof S?.matchMenuLabel, 'function');
  assert.equal(typeof S?.findMenuItem, 'function');
});

test('反义项优先：拉黑项不能被当成静音项', () => {
  assert.equal(S.matchMenuLabel('mute', '静音 @spammer'), true);
  assert.equal(S.matchMenuLabel('mute', '取消静音 @spammer'), false);
  assert.equal(S.matchMenuLabel('unmute', '取消静音 @spammer'), true);

  assert.equal(S.matchMenuLabel('block', '屏蔽 @spammer'), true);
  assert.equal(S.matchMenuLabel('block', '取消屏蔽 @spammer'), false);
  assert.equal(S.matchMenuLabel('unblock', '取消屏蔽 @spammer'), true);
});

test('多语言菜单项：静音', () => {
  const positive = [
    'Mute @spammer',
    '静音 @spammer',
    '靜音 @spammer',
    'ミュート @spammer',
    '음소거 @spammer',
    'Silenciar @spammer',
    'Silenzia @spammer',
    'Stummschalten @spammer',
    'Dempen @spammer',
    'Bisukan @spammer',
    'Заглушить @spammer',
    'كتم @spammer',
    'ปิดเสียง @spammer',
    'Tắt tiếng @spammer',
  ];
  for (const label of positive) assert.equal(S.matchMenuLabel('mute', label), true, label);
});

test('多语言菜单项：取消静音（必须先被判成反义）', () => {
  const anti = [
    'Unmute @spammer',
    '取消静音 @spammer',
    '取消靜音 @spammer',
    'ミュート解除 @spammer',
    '음소거 해제 @spammer',
    'Dejar de silenciar @spammer',
    'Desilenciar @spammer',
    'Stummschaltung aufheben @spammer',
    'Разглушить @spammer',
    'إلغاء كتم @spammer',
    'เปิดเสียง @spammer',
    'Bật tiếng @spammer',
  ];
  for (const label of anti) {
    assert.equal(S.matchMenuLabel('unmute', label), true, `unmute: ${label}`);
    assert.equal(S.matchMenuLabel('mute', label), false, `mute 不该命中: ${label}`);
  }
});

test('多语言菜单项：拉黑 / 取消拉黑', () => {
  for (const label of ['Block @spammer', '屏蔽 @spammer', '拉黑 @spammer', '封锁 @spammer', 'ブロック @spammer', '차단 @spammer', 'Bloquear @spammer', 'Bloquer @spammer', 'Blockieren @spammer', 'Zablokuj @spammer', 'Заблокировать @spammer', 'حظر @spammer']) {
    assert.equal(S.matchMenuLabel('block', label), true, label);
  }
  for (const label of ['Unblock @spammer', '取消屏蔽 @spammer', 'ブロック解除 @spammer', '차단 해제 @spammer', 'Desbloquear @spammer', 'Débloquer @spammer', 'Разблокировать @spammer', 'إلغاء الحظر @spammer']) {
    assert.equal(S.matchMenuLabel('unblock', label), true, `unblock: ${label}`);
    assert.equal(S.matchMenuLabel('block', label), false, `block 不该命中: ${label}`);
  }
});

/**
 * 独立验证（dev 的 task-6）发现的缺口 4：反义表只列固定短语，而「否定词 + 词根」是开放集。
 * 这些语言的正/反例都必须判对，且反例**绝不能**被判成目标动作（点反比失败更糟）。
 */
test('多语言菜单项：pt-BR / ca / pl / fr 的「取消」结构（缺口 4 回归）', () => {
  const cases = [
    // [正例, 反例, 正例动作, 反例动作]
    ['Silenciar @spammer', 'Deixar de silenciar @spammer', 'mute', 'unmute'],
    ['Silencia @spammer', 'Deixa de silenciar @spammer', 'mute', 'unmute'],
    ['Wycisz @spammer', 'Wyłącz wyciszenie @spammer', 'mute', 'unmute'],
    ['Stummschalten @spammer', 'Stummschaltung aufheben @spammer', 'mute', 'unmute'],
    ['Bloquear @spammer', 'Deixar de bloquear @spammer', 'block', 'unblock'],
    ['Zablokuj @spammer', 'Odblokować @spammer', 'block', 'unblock'],
    ['Bloquer @spammer', 'Désactiver le blocage @spammer', 'block', 'unblock'],
  ];
  for (const [positive, anti, action, antiAction] of cases) {
    assert.equal(S.matchMenuLabel(action, positive), true, `${action} 正例：${positive}`);
    assert.equal(S.matchMenuLabel(action, anti), false, `${action} 不该命中反例（点反）：${anti}`);
    assert.equal(S.matchMenuLabel(antiAction, anti), true, `${antiAction} 反例：${anti}`);
  }
});

test('不再行首锚定：文案前面的图标 / 双向控制符不影响匹配', () => {
  assert.equal(S.matchMenuLabel('mute', '🔇 静音 @spammer'), true);
  assert.equal(S.matchMenuLabel('mute', '\u200e静音 @spammer'), true);
  assert.equal(S.matchMenuLabel('mute', '⋮ 静音 @spammer'), true);
  // 但仍然不能把「取消静音」这类反义项放进来
  assert.equal(S.matchMenuLabel('mute', '🔊 取消静音 @spammer'), false);
});

test('非菜单项文案不会误命中（词边界）', () => {
  for (const label of ['关注 @spammer', '不感兴趣', '添加到列表', '举报帖子', 'Copy link', 'Embed Post', 'commuter 乘车人', '解雇']) {
    assert.equal(S.matchMenuLabel('mute', label), false, `mute: ${label}`);
    assert.equal(S.matchMenuLabel('block', label), false, `block: ${label}`);
  }
});

test('确认按钮文案（拉黑确认框）不会被当成菜单项', () => {
  assert.equal(S.isConfirmLabel('Block'), true);
  assert.equal(S.isConfirmLabel('屏蔽'), true);
  assert.equal(S.isConfirmLabel('拉黑'), true);
  assert.equal(S.isConfirmLabel('Silenciar @x'), false);
  assert.equal(S.isConfirmLabel('取消'), false);
});

test('testid 表覆盖静音/拉黑与其反义项', () => {
  assert.deepEqual(S.MENU_ITEM_TESTID.mute, ['mute', 'muteLink']);
  assert.deepEqual(S.MENU_ITEM_TESTID.block, ['block', 'blockLink']);
  assert.equal(S.ANTI_ACTION.mute, 'unmute');
  assert.equal(S.ANTI_ACTION.block, 'unblock');
});
