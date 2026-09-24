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

test('情绪分类：固定 10 类 + 表情，正例逐条命中（v0.4.8 收敛后）', () => {
  assert.equal(Object.keys(EMOTION_CLASSES).length, 10, '用户口径：最多 10 类');
  const cases = {
    anger: ['生气', '气死我了', '太过分了', '离谱', '无语', '服了', '垃圾', '滚', '妈的', '🤬🤬'],
    joy: ['哈哈', '哈哈哈', '嘿嘿', '笑死', '开心', '太好了', '绝了', '太赞了', '😄😄'],
    // 原「确认」并入「支持认同」（v0.4.8）
    support: ['支持', '同意', '认同', '赞同', '加油', '说得对', '有道理', '我也认同', '+1', '111', '确定', '确实', '没错', '没毛病', '对的', '就是这样'],
    oppose: ['反对', '不同意', '不认同', '不行', '拒绝', '呵呵', '算了吧'],
    sadness: ['难过', '泪目', '呜呜', '心碎', '唉'],
    praise: ['美女啊', '太美了', '真好看', '漂亮', '不错', '好帅'],
    // 原「社交」并入「期待求取」（v0.4.8）
    wish: ['我也想去', '好想去', '蹲一个', '期待', '想要', '交朋友', '互关', '求关注', '加个好友'],
    // 原「祝福」并入「问候祝福」（v0.4.8）
    greeting: ['Gm', 'gm', '早上好', '晚安', '你好', 'hi', '中秋快乐', '新年快乐'],
    participation: ['三连', '已三连', '都来参加', '报名', '打卡', '参与啦'],
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

test('兼容旧名 classifyLowSignal：支持/确认→agreement、其余→emotion', () => {
  assert.equal(classifyLowSignal('认同'), 'agreement');
  // v0.4.8 起「确认」并入「支持认同」，旧名只输出 agreement / emotion 两种
  assert.equal(classifyLowSignal('确定'), 'agreement');
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

test('fold 模式：整条线程的低信息量附和只留最早一条当代表，其余（含不同类别）全部合并折叠', () => {
  const recent = [
    { id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1, context: 'reply' },
    { id: 'a2', handle: 'r2', text: '太离谱了', threadId: 'T1', seq: 2, ts: 2 },
    { id: 'a3', handle: 'r3', text: '支持', threadId: 'T1', seq: 3, ts: 3 },
  ];
  const first = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, context: 'reply' }, recent, { mode: 'fold' });
  assert.equal(first.emotion, 'anger');
  assert.equal(first.emotionLabel, '愤怒');
  assert.equal(first.representative, true);
  assert.equal(first.folded, false, '代表条不折叠 → 页面挂「情绪 · 愤怒」徽标');
  assert.equal(first.groupSize, 1, '决定第一条时还不知道后面有几条');

  const second = planEmotionFold({ id: 'a2', handle: 'r2', text: '太离谱了', threadId: 'T1', seq: 2, context: 'reply' }, recent, { mode: 'fold' });
  assert.equal(second.emotion, 'anger');
  assert.equal(second.representative, false);
  assert.equal(second.folded, true);
  assert.equal(second.duplicateOf, 'a1', '指向线程里最早的那条');
  assert.equal(second.groupSize, 2);
  assert.equal(second.mode, 'fold');

  // v0.4.7：`支持` 与 `愤怒` **不再各算一条代表** —— 整条线程合并成一条（用户：「折叠合并成同一条」）。
  const support = planEmotionFold({ id: 'a3', handle: 'r3', text: '支持', threadId: 'T1', seq: 3, context: 'reply' }, recent, { mode: 'fold' });
  assert.equal(support.emotion, 'support', '本条自己的类别仍然保留');
  assert.equal(support.emotionLabel, '支持认同');
  assert.equal(support.representative, false, '不同类别也合并到同一条代表上');
  assert.equal(support.folded, true);
  assert.equal(support.duplicateOf, 'a1');
  assert.equal(support.groupKey, first.groupKey, '整条线程一个组键（不再按类别分组）');
  assert.equal(support.merged, '低信息量附和');
  assert.deepEqual(support.classes, { anger: 2, support: 1 });
  assert.equal(support.groupSize, 3);
});

test('hide 模式：全部折叠（用户说的「删除」），连代表条也不留', () => {
  const recent = [{ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1, context: 'reply' }];
  const first = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, context: 'reply' }, recent, { mode: 'hide' });
  assert.equal(first.mode, 'hide');
  assert.equal(first.representative, false);
  assert.equal(first.folded, true, 'hide 模式下第一条也折叠');
  const single = planEmotionFold({ id: 'z1', handle: 'z', text: '支持', threadId: 'T9', seq: 9, context: 'reply' }, [], { mode: 'hide' });
  assert.equal(single.folded, true);
});

test('并发语义：seq 决定谁是代表条（后到的不会把先到的挤掉）', () => {
  const window = [
    { id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1, context: 'reply' },
    { id: 'a2', handle: 'r2', text: '无语', threadId: 'T1', seq: 2, ts: 2 },
  ];
  // 判定 a1 时窗口里已经有 a2（观察先于判定，并发下会乱序）—— a1 仍然是代表条
  const a1 = planEmotionFold({ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, context: 'reply' }, window, { mode: 'fold' });
  assert.equal(a1.representative, true);
  assert.equal(a1.folded, false);
  assert.equal(a1.duplicateOf, null, '它是最早的，没有参照');
});

test('不折叠的边界：不同线程 / 没有 threadId / 不是情绪', () => {
  const recent = [{ id: 'a1', handle: 'r1', text: '生气', threadId: 'T1', seq: 1, ts: 1, context: 'reply' }];
  assert.equal(planEmotionFold({ id: 'x1', text: '生气', threadId: 'T2', seq: 2, context: 'reply' }, recent, { mode: 'fold' }).groupSize, 1, '跨线程互不影响');
  const feed = planEmotionFold({ id: 'x2', text: '生气', threadId: null, seq: 3, context: 'timeline' }, recent, { mode: 'fold' });
  assert.equal(feed?.scope, 'feed', '时间线（没有线程语义）走 feed：每条各自折叠');
  assert.equal(feed?.folded, true);
  assert.equal(feed?.groupSize, 1);
  assert.equal(planEmotionFold({ id: 'x3', text: '我不同意，公开数据其实是反过来的', threadId: 'T1', seq: 4, context: 'reply' }, recent, { mode: 'fold' }), null, '论点不是情绪');
});


test('情绪分类：10 类里的短句一族（赞美 / 期待求取 / 问候祝福 / 参与）', () => {
  const cases = {
    praise: ['美女啊', '太美了', '真好看', '漂亮', '不错', '好帅'],
    wish: ['我也想去', '好想去', '蹲一个', '期待', '想要', '交朋友', '互关', '求关注', '加个好友'],
    greeting: ['Gm', 'gm', '早上好', '晚安', '你好', 'hi', '中秋快乐'],
    participation: ['三连', '参加', '报名', '打卡', '已三连'],
  };
  for (const [cls, texts] of Object.entries(cases)) {
    for (const text of texts) assert.equal(classifyEmotion(text), cls, text);
  }
  assert.equal(classifyEmotion('👍好'), 'support', '翻译帖里的「👍好」算支持');
});

test('独立验证的漏判已修：加强语/填充/程度补语的中间形态', () => {
  assert.equal(classifyEmotion('我服了'), 'anger', '只削首的中间形态「服了」要保留');
  assert.equal(classifyEmotion('难过死了'), 'sadness', '核心 + 程度补语');
  assert.equal(classifyEmotion('真好看'), 'praise', '连续加强语要保留中间形态');
  assert.equal(classifyEmotion('笑死我了'), 'joy');
  assert.equal(classifyEmotion('气死我了'), 'anger');
});

test('时间线（feed）范围：每条情绪言论各自折叠 + 标类别，不做同类归组', () => {
  const fold = planEmotionFold({ id: 't1', text: '美女啊', context: 'timeline', threadId: null, seq: 1 }, [], { mode: 'fold' });
  assert.equal(fold.scope, 'feed');
  assert.equal(fold.emotion, 'praise');
  assert.equal(fold.emotionLabel, '赞美');
  assert.equal(fold.folded, true, '时间线上直接折叠（内容藏起来 + 条上写类别）');
  assert.equal(fold.representative, false);
  assert.equal(fold.groupSize, 1);

  const hide = planEmotionFold({ id: 't2', text: '太美了', context: 'timeline', threadId: null, seq: 2 }, [], { mode: 'hide' });
  assert.equal(hide.mode, 'hide');
  assert.equal(hide.folded, true);

  // 推荐流与时间线同属 feed
  assert.equal(planEmotionFold({ id: 't3', text: 'Gm', context: 'recommended', threadId: null, seq: 3 }, [], {}).scope, 'feed');
});

/**
 * v0.4.7 —— 用户真站截图：一条活动帖下面的 6 条回复问「这些东西为什么不能折叠合并成同一条」。
 * 修复前实测 6/6 分类为 null（参与句没有短语、赞美要求整串相等、`希望` 在实质词表里）。
 */
test('v0.4.7：用户截图的 6 条（赞美/参与/期待）全部命中并合并成 1 条代表', () => {
  const screenshot = [
    ['佳佳妹妹最好，最美！', 'praise'],
    ['好事多磨，什么时候可以来一份', 'wish'],
    ['已三连！！！', 'participation'],
    ['这个活动好啊', 'praise'],
    ['都来参加', 'participation'],
    ['三连了，希望能中🙏', 'participation'],
  ];
  for (const [text, cls] of screenshot) {
    assert.equal(classifyEmotion(text), cls, `${text} → ${classifyEmotion(text)}（期望 ${cls}）`);
  }
  assert.equal(EMOTION_CLASSES.participation.label, '参与');

  const replies = screenshot.map(([text], i) => ({
    id: `s${i + 1}`, handle: `u${i + 1}`, text, threadId: 'T9', seq: i + 1, ts: i + 1, context: 'reply',
  }));
  const plans = replies.map((target, i) => planEmotionFold(target, replies.slice(0, i), { mode: 'fold' }));
  assert.equal(plans.filter((p) => p?.folded === false).length, 1, '整条线程只有 1 条代表条不折叠');
  assert.equal(plans.filter((p) => p?.folded === true).length, 5, '其余 5 条折叠');
  assert.equal(plans[0].representative, true);
  assert.equal(new Set(plans.map((p) => p.groupKey)).size, 1, '6 条共用一个组键（不再按类别分组）');

  const last = plans[5];
  assert.equal(last.groupSize, 6);
  assert.deepEqual(last.classes, { praise: 2, wish: 1, participation: 3 });
  assert.equal(last.classBreakdown, '参与 3 · 赞美 2 · 期待求取 1');
  assert.equal(last.merged, '低信息量附和');
  assert.equal(last.emotion, 'participation', '本条自己的类别仍然保留');
  assert.equal(last.duplicateOf, 's1');
});

test('v0.4.7：详情页主帖（id === threadId）不折叠，也不能当代表条', () => {
  const root = { id: '1912345678901234567', handle: 'host', text: '都来参加', threadId: '1912345678901234567', seq: 1, ts: 1, context: 'timeline' };
  const reply = { id: '1912345678901234999', handle: 'fan', text: '都来参加', threadId: '1912345678901234567', seq: 2, ts: 2, context: 'reply' };
  assert.equal(planEmotionFold(root, [], { mode: 'fold' }), null, '主帖返回 null（永远不折叠）');
  const plan = planEmotionFold(reply, [root], { mode: 'fold' });
  assert.equal(plan.folded, false, '回复自己当代表条，而不是折到主帖上');
  assert.equal(plan.duplicateOf, null);
  assert.equal(plan.groupSize, 1);
  assert.equal(plan.threadRoot ?? undefined, undefined);
  // 内容脚本显式打了 threadRoot 标记时同样免疫
  assert.equal(planEmotionFold({ ...reply, threadRoot: true }, [], { mode: 'fold' }), null);
});

test('v0.4.7：模板的误伤护栏（实质词前缀 / 最高级误用 / 反转句）', () => {
  const mustNotFold = [
    '成本太高可以来一份',
    '这个价格什么时候可以来一份',
    '最好别来',
    '好人最好骗',
    '大家最好注意',
    '这期视频有意思，但我更想看上一期',
    '这个活动好啊，但奖品只有一份太少了',
    '三连了，但是视频第 3 分钟的数据错了',
    '什么时候可以来一份活动规则说明',
  ];
  for (const text of mustNotFold) assert.equal(classifyEmotion(text), null, text);
});

/**
 * v0.4.8 —— 用户口径：「应该获得全量的信息，然后分类成几类。折叠几类就行了。最多 10 类。」
 * 于是：类别收敛到 10 类；分类不再只认「整串等于某个专属句式」，而是
 * ① 核心短语（≤12 字）→ ② 整串锚定模板（≤20 字）→ ③ **全量文本覆盖率判定**（≤60 字：
 * 落在词表里的字符 ≥70%，且某类证据 ≥2 字，且无实质词/数字/链接/劝告否定句）。
 */
test('v0.4.8：真站第二批 8 条（没有专属模板的整句）全部被归类', () => {
  const screenshot = [
    ['哇塞，参与啦，佳佳姐', 'participation'],
    ['报告，我想参加，可是没有周边🥺', 'wish'],
    ['中秋快乐梦想成真', 'greeting'],
    ['佳佳姐真的需要一份周边参加活动', 'wish'],
    ['我是真没有周边，咋搞', 'wish'],
    ['中秋快乐，非常喜欢今年okx的周边，太爱了！', 'greeting'],
    ['首先得有周边', 'wish'],
    ['Okx的活动太高级了，周边也很漂亮', 'praise'],
  ];
  for (const [text, cls] of screenshot) {
    assert.equal(classifyEmotion(text), cls, `${text} → ${classifyEmotion(text)}（期望 ${cls}）`);
  }
  // 同线程 8 条 → 仍然只留 1 条代表（用户上一轮的「合并成同一条」没有被破坏）
  const replies = screenshot.map(([text], i) => ({
    id: `n${i + 1}`, handle: `h${i + 1}`, text, threadId: 'T8', seq: i + 1, ts: i + 1, context: 'reply',
  }));
  const plans = replies.map((target, i) => planEmotionFold(target, replies.slice(0, i), { mode: 'fold' }));
  assert.equal(plans.filter((p) => p?.folded === false).length, 1);
  assert.equal(plans[7].groupSize, 8);
  assert.equal(new Set(plans.map((p) => p.groupKey)).size, 1);
  assert.match(plans[7].classBreakdown, /问候祝福/);
  assert.match(plans[7].classBreakdown, /期待求取/);
});

test('v0.4.8：覆盖率判定能泛化（同一句话里混合多类词，取证据最多的一类）', () => {
  const cases = [
    ['我也想参加这个活动', ['participation', 'wish']],
    ['已经报名了，坐等开奖', ['participation', 'wish']],
    ['大家中秋快乐，祝梦想成真', ['greeting']],
    ['中秋快乐呀大家', ['greeting']],
    ['周边真的很好看', ['praise']],
    ['互关一下交个朋友', ['wish']],
    ['我也来支持一下，太棒了', ['support', 'praise']],
  ];
  for (const [text, allowed] of cases) {
    assert.ok(allowed.includes(classifyEmotion(text)), `${text} → ${classifyEmotion(text)}（期望 ${allowed.join('/')}）`);
  }
});

test('v0.4.8：覆盖率判定的否决（实质词 / 劝告否定 / 问句 / 事务句一律不折叠）', () => {
  const mustNotFold = [
    '这个活动名额太少，我放弃了',
    '我没有时间参加这个活动',
    '周边产品的定价策略',
    '参加活动的注意事项',
    '中秋月饼的销量数据',
    '活动规则在哪里看',
    '资格认证流程',
    '福利院的孩子需要帮助',
    '最好别来',
    '别忘报名',
    '我参加过一次',
    '报名截止了吗',
    '今天天气最好',
    '这个方案最好',
    '好人最好骗',
    '最美不过夕阳红',
    '活动几点开始',
    '这个活动名额太多，不划算',
  ];
  for (const text of mustNotFold) assert.equal(classifyEmotion(text), null, `${text} → ${classifyEmotion(text)}`);
});
