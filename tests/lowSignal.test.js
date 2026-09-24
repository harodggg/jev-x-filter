/**
 * 「情绪 / 认同 / 确认」这类**没有实质内容的附和**：同一线程只留最早一条。
 *
 * 用户 2026-09 的需求：「情绪 认同 确定 之类的应该只显示一个」。
 * 它们彼此字符串不同（`认同` / `确定` / `哈哈哈`），3-gram 相似度与文案农场都抓不到，
 * 所以这里用一版本地分类（0 次模型调用）把它们按「同线程 + 同类」折叠。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOW_SIGNAL_MAX_CHARS, classifyLowSignal, planLowSignalFold } from '../src/sw/lowSignal.js';

test('附和分类：认同 / 确认 / 情绪三类正例', () => {
  for (const text of ['认同', '同意', '赞成', '赞同', '支持', '附议', '同感', '说得对', '有道理', '对的', '是的', '没错', '没毛病', '我也认同', '完全同意', '认同呀', '对对对', '支持支持', '+1', '111', '嗯嗯，对']) {
    assert.equal(classifyLowSignal(text), 'agreement', text);
  }
  for (const text of ['确定', '确认', '确实', '的确', '果然', '正确', '就是这样']) {
    assert.equal(classifyLowSignal(text), 'confirmation', text);
  }
  for (const text of ['哈哈', '哈哈哈', '哈哈哈哈', '嘿嘿', '笑死', '泪目', '呜呜', '爱了', '好可爱', '喜欢', '实在是太赞了', '😂😂', '❤️']) {
    assert.equal(classifyLowSignal(text), 'emotion', text);
  }
});

test('附和分类：讲事情的回复绝不折叠（否定 / 理由 / 疑问 / 数字 / 链接 / 长文本）', () => {
  const mustNotFold = [
    '我不同意',
    '不确定',
    '不认同',
    '不对',
    '反对这个方案',
    '我没有意见',
    '确实有问题',
    '我支持这个政策，因为方向是对的',
    '同意，但前提是数据要公开',
    '为什么会这样？',
    '我觉得应该先讨论',
    '3 天后再说',
    'https://t.co/abcdefg',
    '哈哈哈这也太好笑了我笑了五分钟',
    `这是一个很长很长的回复${'啊'.repeat(LOW_SIGNAL_MAX_CHARS)}`,
  ];
  for (const text of mustNotFold) assert.equal(classifyLowSignal(text), null, text);
});

test('附和分类：空文本 / 纯标点不折叠（孤立的问号是内容）', () => {
  assert.equal(classifyLowSignal(''), null);
  assert.equal(classifyLowSignal('   '), null);
  assert.equal(classifyLowSignal('？'), null);
  assert.equal(classifyLowSignal('。。。'), null);
});

test('同线程同类附和才折叠，且指向最早的那条', () => {
  const recent = [
    { id: 'a1', handle: 'reply_a', text: '认同', threadId: 'T1', seq: 1, ts: 1 },
    { id: 'a2', handle: 'reply_b', text: '确实', threadId: 'T1', seq: 2, ts: 2 },
    { id: 'a3', handle: 'reply_c', text: '我不同意，公开数据其实是反过来的', threadId: 'T1', seq: 3, ts: 3 },
  ];
  const second = planLowSignalFold({ id: 'a4', handle: 'reply_d', text: '确定', threadId: 'T1', seq: 4 }, recent);
  assert.equal(second?.kind, 'agreement');
  assert.equal(second?.folded, true);
  assert.equal(second?.duplicateOf, 'a2', '同类里最早的那条（确实）');
  assert.equal(second?.duplicateOfHandle, 'reply_b');
  assert.equal(second?.groupSize, 2, '同类只有两条时才报 2');
  assert.equal(second?.lowSignal, 'confirmation');
  assert.match(second?.groupKey ?? '', /^ls:T1:/);

  const first = planLowSignalFold({ id: 'a2', handle: 'reply_b', text: '确实', threadId: 'T1', seq: 2 }, [
    { id: 'a3', handle: 'reply_c', text: '我不同意，公开数据其实是反过来的', threadId: 'T1', seq: 3, ts: 3 },
  ]);
  assert.equal(first, null, '同类里没有更早的 → 不折叠（它是代表条）');
});

test('不折叠的边界：不同线程 / 不同类 / 没有 threadId / 自己就是实质回复', () => {
  const recent = [{ id: 'a1', handle: 'reply_a', text: '认同', threadId: 'T1', seq: 1, ts: 1 }];
  assert.equal(planLowSignalFold({ id: 'x1', text: '认同', threadId: 'T2', seq: 2 }, recent), null, '跨线程不折叠');
  assert.equal(planLowSignalFold({ id: 'x2', text: '确定', threadId: 'T1', seq: 3 }, recent), null, '同类才折叠（认同 vs 确定）');
  assert.equal(planLowSignalFold({ id: 'x3', text: '认同', threadId: null, seq: 4 }, recent), null, '没有 threadId 不折叠');
  assert.equal(planLowSignalFold({ id: 'x4', text: '我不同意，公开数据其实是反过来的', threadId: 'T1', seq: 5 }, recent), null);
  assert.equal(planLowSignalFold({ id: 'a1', text: '认同', threadId: 'T1', seq: 1 }, recent), null, '不会把自己当成参照');
});

test('同类附和连续出现时 groupSize 递增（只留最早一条）', () => {
  const recent = [
    { id: 'a1', handle: 'r1', text: '认同', threadId: 'T1', seq: 1, ts: 1 },
    { id: 'a2', handle: 'r2', text: '同意', threadId: 'T1', seq: 2, ts: 2 },
    { id: 'a3', handle: 'r3', text: '支持', threadId: 'T1', seq: 3, ts: 3 },
  ];
  const third = planLowSignalFold({ id: 'a4', handle: 'r4', text: '我也认同', threadId: 'T1', seq: 4 }, recent);
  assert.equal(third?.duplicateOf, 'a1');
  assert.equal(third?.groupSize, 4);
});
