import test from 'node:test';
import assert from 'node:assert/strict';
import { FARM_MIN_CHARS, createFarmTracker, farmKey, normalizeFarmText } from '../src/sw/farm.js';

test('归一化：吃掉 emoji、标点、大小写、零宽字符 —— 换装躲不掉', () => {
  const a = normalizeFarmText('应该没人比我玩的开了吧🤣💖我福不黑不信你看');
  const b = normalizeFarmText('应该没人比我玩的开了吧 😭 我福不黑 不信你看！');
  assert.equal(a, b);
  assert.equal(normalizeFarmText('ＡＢＣ１２３'), 'abc123');
  assert.equal(normalizeFarmText('Only\u200bFans'), 'onlyfans');
});

test('太短的内容不参与农场判定（避免大众短语误伤）', () => {
  assert.equal(farmKey('哈哈'), null);
  assert.equal(farmKey('太好了太好了'), null, `短于 ${FARM_MIN_CHARS} 个有效字符`);
  assert.ok(farmKey('应该没人比我玩的开了吧我福不黑不信你看'));
});

test('农场：默认 2 个不同账号即命中；同账号重复不算', () => {
  const tracker = createFarmTracker({ windowMs: 60000, now: () => 0 });
  const text = '太阳射☀️不进去的地方💪你可以';
  assert.equal(tracker.record(text, 'lisa82am4', { nowMs: 1000 }).hit, false);
  assert.equal(tracker.record(text, 'lisa82am4', { nowMs: 2000 }).hit, false, '同账号重复不算新账号');
  const second = tracker.record(text, 'marie61ff2', { nowMs: 3000 });
  assert.equal(second.hit, true, '默认阈值是 2 个不同账号');
  assert.equal(second.accounts, 2);
  const third = tracker.record(text, 'lori73sv6', { nowMs: 4000 });
  assert.equal(third.accounts, 3);
});

test('农场：窗口外的时间戳被淘汰，不会把隔天的话算成一个农场', () => {
  const tracker = createFarmTracker({ minAccounts: 3, windowMs: 10000 });
  tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'a', { nowMs: 0 });
  tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'b', { nowMs: 1000 });
  const late = tracker.record('应该没人比我玩的开了吧我福不黑不信你看', 'c', { nowMs: 100000 });
  assert.equal(late.hit, false, 'a/b 已过期，只剩 c');
});

test('农场：2 个账号时也要求内容够长（短句不参与）', () => {
  const tracker = createFarmTracker({ windowMs: 60000 });
  assert.equal(tracker.record('好的', 'a', { nowMs: 0 }).hit, false, '短句没有农场键');
  assert.equal(tracker.record('好的', 'b', { nowMs: 10 }).hit, false);
});

test('农场：命中后不会重复计数，配置可热更新', () => {
  const tracker = createFarmTracker({ minAccounts: 2, windowMs: 60000 });
  const text = '应该没人比我玩的开了吧我福不黑不信你看';
  assert.equal(tracker.record(text, 'a', { nowMs: 0 }).hit, false);
  assert.equal(tracker.record(text, 'b', { nowMs: 10 }).hit, true);
  assert.equal(tracker.record(text, 'a', { nowMs: 20 }).hit, true, '老账号再来一条仍是命中');

  tracker.configure({ minAccounts: 5 });
  assert.equal(tracker.record(text, 'c', { nowMs: 30 }).hit, false, '配置提高后需要 5 个账号');
  tracker.clear();
  assert.equal(tracker.size(), 0);
});

test('农场键与内容脚本里的实现必须逐字一致（防两处漂移）', async () => {
  await import('../src/content/extract.js'); // 传统脚本，靠副作用挂到 globalThis
  const contentFarmKey = globalThis.JevXExtract.farmKey;
  assert.equal(typeof contentFarmKey, 'function');
  const samples = [
    '应该没人比我玩的开了吧🤣💖我福不黑不信你看',
    '太阳射☀️不进去的地方💪你可以',
    'ＡＢＣ１２３ 这是全角',
    'x'.repeat(9),
    'x'.repeat(10),
    '',
  ];
  for (const sample of samples) {
    assert.equal(contentFarmKey(sample), farmKey(sample), sample);
  }
});
