/**
 * 情绪 / 态度分类与折叠计划（本地、0 次模型调用）。
 *
 * 需求：「把所有的情绪言论给折叠/删除，然后给予愤怒，喜悦，支持，反对，之类的信息」。
 * 分类是**保守**的：只有「整串恰好是某条情绪短语」（可带加强语/语气词）才算情绪言论，
 * 讲理由、提问题、带数字/链接、超长的一律不折叠 —— 要折叠的是情绪，不是论点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTION_CLASSES,
  LOW_SIGNAL_MAX_CHARS,
  classifyEmotion,
  classifyLowSignal,
  planEmotionFold,
} from '../src/sw/lowSignal.js';

test('情绪分类：六类 + 表情，正例逐条命中', () => {
  const cases = {
    anger: ['生气', '气死我了', '太过分了', '离谱', '无语', '服了', '垃圾', '滚', '妈的', '🤬🤬'],
    joy: ['哈哈', '哈哈哈', '嘿嘿', '笑死', '开心', '太好了', '绝了', '太赞了', '😄😄'],
    support: ['支持', '同意', '认同', '赞同', '加油', '说得对', '有道理', '我也认同', '+1', '111'],
    oppose: ['反对', '不同意', '不认同', '不行', '拒绝', '呵呵', '算了吧'],
    sadness: ['难过', '泪目', '呜呜', '心碎', '唉'],
    confirmation: ['确定', '确实', '没错', '没毛病', '对的', '就是这样'],
  };
  for (const [cls, texts] of Object.entries(cases)) {
    for (const text of texts) {
      // 纯 emoji 会落到 `emoji`（知道是情绪但分不出哪一类），其余必须命中对应类别
      const got = classifyEmotion(text);
      const expect = cls === 'anger' && text.startsWith('🤬') ? 'emoji' : cls === 'joy' && text.startsWith('😄') ? 'emoji' : cls;
      assert.equal(got, expect, `${text} → ${got}（期望 ${expect}）`);
    }
  }
  assert.equal(EMOTION_CLASSES.emoji.label, '表情');
  assert.equal(classifyEmotion('😂😂'), 'emoji');
});

test('兼容旧名 classifyLowSignal：支持→agreement、确认→confirmation、其余→emotion', () => {
  assert.equal(classifyLowSignal('认同'), 'agreement');
  assert.equal(classifyLowSignal('确定'), 'confirmation');
  assert.equal(classifyLowSignal('哈哈哈'), 'emotion');
  assert.equal(classifyLowSignal('生气'), 'emotion');
  assert.equal(classifyLowSignal('我不同意，公开数据其实是反过来的'), null);
});

test('情绪分类：讲事情的回复绝不当作情绪（理由 / 转折 / 疑问 / 数字 / 链接 / 长文本）', () => {
  const mustNotFold = [
    '我不同意，公开数据其实是反过来的',
    '不同意，但前提是数据要公开',
    '反对这个方案，因为成本太高了',
    '为什么会这样？',
    '3 天后再说',
    'https://t.co/abcdefg',
    '我觉得应该先讨论',
    '这个方案的成本太高了',
    '数据统计显示成本上升了三成',
    `这是一个很长很长的回复${'啊'.repeat(LOW_SIGNAL_MAX_CHARS)}`,
  ];
  for (const text of mustNotFold) assert.equal(classifyEmotion(text), null, text);
});

test('情绪分类：空文本 / 纯标点不算情绪（孤立的问号是内容）', () => {
  assert.equal(classifyEmotion(''), null);
  assert.equal(classifyEmotion('   '), null);
  assert.equal(classifyEmotion('？'), null);
  assert.equal(classifyEmotion('。。。'), null);
});

test('fold 模式：同类情绪第一条是代表条（挂徽标），第二条起折叠', () => {
  const recent = [
    { id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1 },
    { id: 'a2', handle: 'r2', text: '太离谱了', threadId: 'T1', seq: 2, ts: 2 },
    { id: 'a3', handle: 'r3', text: '支持', threadId: 'T1', seq: 3, ts: 3 },
  ];
  const first = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1 }, recent, { mode: 'fold' });
  assert.equal(first.emotion, 'anger');
  assert.equal(first.emotionLabel, '愤怒');
  assert.equal(first.representative, true);
  assert.equal(first.folded, false, '代表条不折叠 → 页面挂「情绪 · 愤怒」徽标');
  assert.equal(first.groupSize, 1, '决定第一条时还不知道后面有几条');

  const second = planEmotionFold({ id: 'a2', handle: 'r2', text: '太离谱了', threadId: 'T1', seq: 2 }, recent, { mode: 'fold' });
  assert.equal(second.emotion, 'anger');
  assert.equal(second.representative, false);
  assert.equal(second.folded, true);
  assert.equal(second.duplicateOf, 'a1', '指向同类里最早的那条');
  assert.equal(second.groupSize, 2);
  assert.equal(second.mode, 'fold');

  const support = planEmotionFold({ id: 'a3', handle: 'r3', text: '支持', threadId: 'T1', seq: 3 }, recent, { mode: 'fold' });
  assert.equal(support.emotion, 'support');
  assert.equal(support.representative, true, '不同类别各自算一条代表');
});

test('hide 模式：全部折叠（用户说的「删除」），连代表条也不留', () => {
  const recent = [{ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1 }];
  const first = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1 }, recent, { mode: 'hide' });
  assert.equal(first.mode, 'hide');
  assert.equal(first.representative, false);
  assert.equal(first.folded, true, 'hide 模式下第一条也折叠');
  const single = planEmotionFold({ id: 'z1', handle: 'z', text: '支持', threadId: 'T9', seq: 9 }, [], { mode: 'hide' });
  assert.equal(single.folded, true);
});

test('并发语义：seq 决定谁是代表条（后到的不会把先到的挤掉）', () => {
  const window = [
    { id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1 },
    { id: 'a2', handle: 'r2', text: '无语', threadId: 'T1', seq: 2, ts: 2 },
  ];
  // 判定 a1 时窗口里已经有 a2（观察先于判定，并发下会乱序）—— a1 仍然是代表条
  const a1 = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1 }, window, { mode: 'fold' });
  assert.equal(a1.representative, true);
  assert.equal(a1.folded, false);
  assert.equal(a1.duplicateOf, null, '它是最早的，没有参照');
});

test('不折叠的边界：不同线程 / 没有 threadId / 不是情绪', () => {
  const recent = [{ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1 }];
  assert.equal(planEmotionFold({ id: 'x1', text: '生气', threadId: 'T2', seq: 2 }, recent, { mode: 'fold' }).groupSize, 1, '跨线程互不影响');
  assert.equal(planEmotionFold({ id: 'x2', text: '生气', threadId: null, seq: 3 }, recent, { mode: 'fold' }), null, '没有 threadId 不处理');
  assert.equal(planEmotionFold({ id: 'x3', text: '我不同意，公开数据其实是反过来的', threadId: 'T1', seq: 4 }, recent, { mode: 'fold' }), null, '论点不是情绪');
});
