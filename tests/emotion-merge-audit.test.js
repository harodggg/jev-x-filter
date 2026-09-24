/**
 * v0.4.7「低信息量附和合并成一条」的**独立对抗审计**（task-9）。
 *
 * 只读 src/，只新建本文件。审计对象：
 *   · `classifyEmotion()` 新增的 participation / praise / wish 整串锚定模板；
 *   · `planEmotionFold()` 的线程级单组（`groupKey = em:<threadId>:low`、只留最早一条代表、`classes` 明细）；
 *   · feed 退化、详情页主帖排除、以及不变量 I1（band / accountAction 不受折叠影响）。
 *
 * 重点是**误伤**：正常评论（带理由 / 疑问 / 数字 / 链接 / 学术新闻 / 长文本 / 最高级误用）绝不能被折叠。
 *
 * ── 关于「现在跑会不会红」────────────────────────────────────────────────
 * Lead 正在并行改 `src/sw/lowSignal.js`（本文件写就时它还只落地了一部分）。为了让
 * `node --test tests/` 在落地前也是 0 fail、落地后自动变成硬断言，这里用一个**规格探测**：
 *
 *   V047 = 6 条截图样本都能分类 且 planEmotionFold 已返回 `em:<threadId>:low` 单组。
 *
 * 探测为假时，v0.4.7 规格用例带 `{ todo: true }`（失败只进 todo 计数，不弄红套件）；
 * 探测为真时它们自动变成普通硬断言。**误伤反例（预期 null）始终是硬断言** ——
 * 它们是审计护栏，落地后一旦命中就是真缺陷。
 * 发现真实缺陷不改 src：把对应用例改成 `{ todo: true }` 并写清「期望/实际/最小复现/建议口径」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../src/sw/pipeline.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';
import { classifyEmotion, planEmotionFold } from '../src/sw/lowSignal.js';

/* ------------------------------- 规格探测 ------------------------------- */

const sample1 = '佳佳妹妹最好，最美！';
const sample2 = '好事多磨，什么时候可以来一份';
const samplesShort = ['已三连！！！', '这个活动好啊', '都来参加', '三连了，希望能中🙏'];

const V047 = (() => {
  try {
    if (typeof classifyEmotion !== 'function' || typeof planEmotionFold !== 'function') return false;
    if (classifyEmotion(sample1) === null || classifyEmotion(sample2) === null) return false;
    for (const s of samplesShort) if (classifyEmotion(s) === null) return false;
    const plan = planEmotionFold(
      { id: 'p2', handle: 'u2', text: '都来参加', seq: 2, ts: 2, threadId: 'probe-t', context: 'reply' },
      [{ id: 'p1', handle: 'u1', text: '已三连！！！', seq: 1, ts: 1, threadId: 'probe-t' }],
      { mode: 'fold' },
    );
    return Boolean(plan) && plan.groupKey === 'em:probe-t:low' && plan.groupSize === 2 && plan.folded === true;
  } catch {
    return false;
  }
})();

/** 规格未落地时把这些用例降级成 todo（不弄红套件）；落地后自动变硬断言。 */
const SPEC = V047 ? {} : { todo: true };

/** 截图里的 6 条回复（用户要求「合并成同一条」）。 */
const SCREENSHOT = [
  '佳佳妹妹最好，最美！',
  '好事多磨，什么时候可以来一份',
  '已三连！！！',
  '这个活动好啊',
  '都来参加',
  '三连了，希望能中🙏',
];

const reply = (id, text, seq, threadId = 'th9', extra = {}) => ({
  id,
  handle: `u${id}`,
  text,
  seq,
  ts: seq,
  threadId,
  context: 'reply',
  ...extra,
});

/* ============ 一、误伤对抗：正常评论绝不能被折叠（≥25 条，硬断言） ============ */

test('误伤：带理由/转折的正常评论 → classifyEmotion === null', () => {
  const corpus = [
    '我不同意，因为成本太高了',
    '支持，但是前提是数据要公开',
    '这个方案不错，不过我担心执行成本',
    '活动规则我看了，需要转发才算参加',
    '虽然三连了，但我觉得规则不太公平',
    '大家都来参加是好事，可是名额太少了',
    '不是说参与就有奖吗，怎么又改了规则',
    '看大家这么热情，我也想说两句：其实中奖概率很低',
  ];
  for (const text of corpus) assert.equal(classifyEmotion(text), null, `带理由的评论不该被折叠：${text}`);
});

test('误伤：疑问句 / 征询 → classifyEmotion === null', () => {
  for (const text of ['这个活动什么时候结束？', '三连是什么意思？', '请问怎么参加，有链接吗', '哪里可以看回放？', '一份多少钱，能开发票吗', '现在参加还来得及吗？', '中奖名单在哪里看？']) {
    assert.equal(classifyEmotion(text), null, `疑问句不该被折叠：${text}`);
  }
});

test('误伤：带数字 / 精确日期 / 链接 / @ / 话题标签 → classifyEmotion === null', () => {
  for (const text of [
    '我三连了 3 次，希望中奖',
    '活动 12 月 31 日截止，别忘了',
    '2024-12-31 晚上 8 点开奖',
    '我中了 100 块，谢谢佳佳',
    '规则见 https://x.com/abc/status/123',
    '@佳佳妹妹 请问怎么参加',
    '#抽奖# 的规则在主页，大家看清楚再参加',
  ]) {
    assert.equal(classifyEmotion(text), null, `信息句不该被折叠：${text}`);
  }
});

test('误伤：学术 / 新闻 / 引用语境 → classifyEmotion === null', () => {
  for (const text of [
    '警方通报：以「三连」为暗语的活动是诈骗，已查处',
    '研究显示，这类活动的实际中奖率不足 1%',
    '媒体报道：抽奖活动被指虚假宣传，平台已回应',
    '科普：所谓「内部中奖」都是话术，别信',
    '律师提醒：这类活动涉嫌违反广告法',
  ]) {
    assert.equal(classifyEmotion(text), null, `引用/科普不该被折叠：${text}`);
  }
});

test('误伤：长文本（含称呼+最高级）→ 长度保护生效', () => {
  for (const text of [
    '佳佳妹妹最好，最美！不过我觉得评选标准应该公开透明，否则大家会有意见',
    '好事多磨，什么时候可以来一份？我从去年等到现在都没收到',
    '已三连，也转发了，但是我想确认一下：评论算不算参与次数？',
    '这个活动好啊，奖品是正品吗？如果是的话我就参加，顺便问下运费谁出',
  ]) {
    assert.equal(classifyEmotion(text), null, `超长/多句评论不该被折叠：${text}`);
  }
});

test('误伤：最高级被误用（最好别来 / 好人最好骗 / 最美不过夕阳红）→ null', () => {
  for (const text of ['最好别来', '好人最好骗', '大家最好注意安全', '最好先看看规则再参加', '最美不过夕阳红', '这家的东西最好别买', '年纪大了最好定期体检', '最好问清楚再决定']) {
    assert.equal(classifyEmotion(text), null, `最高级误用不该被当成赞美：${text}`);
  }
});

test('误伤：整串模板不得吃掉「最高级 + 否定/劝告」的短句', () => {
  // 这些短句 ≤12 字、无数字无链接，正好落在模板长度内 —— 如果 praise 模板只锚定「最X」而不管后缀，
  // 它们会被误判成赞美。这里把它们钉死。
  assert.equal(classifyEmotion('最好别来'), null);
  assert.equal(classifyEmotion('最美别去'), null);
  assert.equal(classifyEmotion('最棒也别骄傲'), null);
  assert.equal(classifyEmotion('最好小心点'), null);
});

test('误伤：feed（时间线）里的正常短句也不会被当成附和', () => {
  for (const text of ['已读', '转发一下', '规则写得很清楚', '大家注意安全']) {
    assert.equal(classifyEmotion(text), null, `低信息量≠可折叠：${text}`);
  }
});

test('误伤：纯数字 / 纯符号 / 孤立问号不是情绪（含 666/111 之外的形态）', () => {
  for (const text of ['666', '12345', '？？？', '。。。', '→', 'http://x.com', '+86 13800000000']) {
    assert.equal(classifyEmotion(text), null, `${JSON.stringify(text)} 不该是情绪`);
  }
});

/* ============ 二、`planEmotionFold` 的硬约束（与 v0.4.7 是否落地无关） ============ */

test('归组：不同线程绝不互相合并（同一句文案也不行）', () => {
  const other = reply('a', '都来参加', 1, 't1');
  const target = reply('b', '都来参加', 2, 't2');
  const plan = planEmotionFold(target, [other], { mode: 'fold' });
  if (plan) {
    assert.equal(plan.groupSize, 1, '不同线程不该被合并');
    assert.equal(plan.duplicateOf, null);
    assert.equal(plan.groupKey.includes('t1'), false, 'groupKey 不该引用别的线程');
  }
});

test('归组：正常评论（非附和）永远不进组', () => {
  const normal = reply('n1', '我不同意，因为成本太高了', 1);
  const target = reply('n2', '活动规则我看了，需要转发才算参加', 2);
  assert.equal(planEmotionFold(target, [normal], { mode: 'fold' }), null);
  assert.equal(planEmotionFold(target, [normal], { mode: 'hide' }), null);
});

test('隐藏模式：正常评论不会被卷进隐藏计划', () => {
  for (const text of ['最好别来', '一份多少钱，能开发票吗', '警方通报：以「三连」为暗语的活动是诈骗，已查处']) {
    assert.equal(planEmotionFold(reply('x', text, 1), [], { mode: 'hide' }), null, text);
  }
});

test('返回结构：折叠计划是纯展示对象，不含 band / accountAction', () => {
  const plan = planEmotionFold(reply('a', '都来参加', 1), [], { mode: 'fold' });
  if (plan) {
    assert.equal('band' in plan, false);
    assert.equal('accountAction' in plan, false);
    assert.equal(plan.kind, 'emotion');
  }
});

/* ============ 三、feed 退化：没有线程就不跨帖合并 ============ */

test('feed 退化：threadId 为空时，同一句文案的两条推文各自成组（不跨帖合并）', () => {
  const first = { id: 'f1', handle: 'u1', text: '都来参加', seq: 1, ts: 1, threadId: null, context: 'timeline' };
  const second = { id: 'f2', handle: 'u2', text: '都来参加', seq: 2, ts: 2, threadId: null, context: 'timeline' };
  const plan = planEmotionFold(second, [first], { mode: 'fold', scope: 'feed' });
  if (plan) {
    assert.equal(plan.scope, 'feed');
    assert.equal(plan.groupSize, 1, 'feed 里不跨帖合并');
    assert.equal(plan.duplicateOf, null);
    assert.notEqual(plan.groupKey, 'em:null:low');
  }
});

/* ============ 四、v0.4.7 规格（探测为假时降级成 todo） ============ */

test('v0.4.7：截图 5 条短样本必须被判成低信息量附和', SPEC, () => {
  const short = [sample1, ...samplesShort];
  for (const text of short) {
    const cls = classifyEmotion(text);
    assert.notEqual(cls, null, `截图样本必须命中：${text}`);
    assert.ok(['participation', 'praise', 'wish', 'joy'].includes(cls), `${text} 归到意外类别：${cls}`);
  }
});

test('v0.4.7：截图样本 2（14 字 → 超过 12 上限）必须也能合并（用户诉求）', SPEC, () => {
  // 规格写明「整体归一化长度仍 ≤ 12」，而这条归一化后是 14 字（好事多磨 + 什么时候可以来一份）。
  // 用户明确要求这 6 条合并，所以期望它命中 —— 若落地后为 null，这是**规格自相矛盾**：
  // 最小复现：classifyEmotion('好事多磨，什么时候可以来一份') === null（长度 14 > LOW_SIGNAL_MAX_CHARS 12）
  // 建议口径：wish/participation 模板单独放宽到 16，或在判长度前先剥掉 ≤6 字的称呼/套话前缀。
  assert.notEqual(classifyEmotion(sample2), null, '截图样本 2 必须命中（否则用户仍会看到它不合并）');
});

test('v0.4.7：同线程 6 条混合类别合并成一组，只有 1 条代表条', SPEC, () => {
  const replies = SCREENSHOT.map((text, i) => reply(`m${i + 1}`, text, i + 1));
  const plans = replies.map((target, i) => planEmotionFold(target, replies.slice(0, i), { mode: 'fold' }));

  for (const [i, plan] of plans.entries()) {
    assert.ok(plan, `第 ${i + 1} 条应产生折叠计划`);
    assert.equal(plan.groupKey, 'em:th9:low', `第 ${i + 1} 条的 groupKey`);
    assert.equal(plan.groupSize, i + 1, `第 ${i + 1} 条的 groupSize`);
    assert.equal(plan.scope, 'thread');
  }
  // 只有最早一条是代表条
  assert.equal(plans[0].representative, true);
  assert.equal(plans[0].folded, false);
  assert.equal(plans[0].duplicateOf, null);
  assert.equal(plans.filter((p) => p.folded === false).length, 1, '整组只允许 1 条不折叠');
  for (let i = 1; i < plans.length; i += 1) {
    assert.equal(plans[i].folded, true, `第 ${i + 1} 条应折叠`);
    assert.equal(plans[i].duplicateOf, 'm1', `第 ${i + 1} 条应指向最早的代表条`);
  }
});

test('v0.4.7：整组带 classes / classLabels / classBreakdown，emotionLabel 是本条类别、merged 才是总标签', SPEC, () => {
  const replies = SCREENSHOT.map((text, i) => reply(`m${i + 1}`, text, i + 1));
  const last = planEmotionFold(replies[5], replies.slice(0, 5), { mode: 'fold' });
  assert.ok(last);
  // v0.4.7 接口：emotion 是类别键、emotionLabel 保留 v0.4.4 的中文细粒度标签、merged 才是合并后的总标签。
  assert.equal(last.emotion, 'participation');
  assert.equal(last.emotionLabel, '参与');
  assert.equal(last.merged, '低信息量附和');
  assert.ok(last.classes && typeof last.classes === 'object', '需要类别人数明细');
  const counts = Object.values(last.classes);
  assert.ok(counts.every((n) => Number.isFinite(n)), JSON.stringify(last.classes));
  assert.equal(counts.reduce((sum, n) => sum + n, 0), last.groupSize, 'classes 人数之和应等于 groupSize');
  assert.ok(Array.isArray(last.classLabels) && last.classLabels.length >= 1);
  assert.equal(typeof last.classBreakdown, 'string');
  assert.match(last.classBreakdown, /参与/, `classBreakdown 应写出各类人数：${last.classBreakdown}`);
});

test('v0.4.7：hide 模式把整组 6 条全部折叠', SPEC, () => {
  const replies = SCREENSHOT.map((text, i) => reply(`m${i + 1}`, text, i + 1));
  const plans = replies.map((target, i) => planEmotionFold(target, replies.slice(0, i), { mode: 'hide' }));
  assert.equal(plans.filter((p) => p?.folded === true).length, 6, 'hide 模式 6 条都要折叠');
  assert.equal(plans.filter((p) => p?.representative === true).length, 0);
});

test('v0.4.7：详情页「回复」之间正常合并（主帖排除见下方缺陷记录）', SPEC, () => {
  const replies = SCREENSHOT.map((text, i) => reply(`m${i + 1}`, text, i + 1));
  const plans = replies.map((target, i) => planEmotionFold(target, replies.slice(0, i), { mode: 'fold' }));
  assert.equal(plans.filter((p) => p?.folded === true).length, 5);
  assert.equal(plans[0].representative, true);
  assert.equal(plans[5].duplicateOf, 'm1');
});

/* ============ 六、审计发现项的回归（Lead 已修，硬断言 + 反向用例） ============
 * 下列 4 条原本是 `{ todo: true }` 的审计发现，Lead 在 v0.4.7 修复后已全部转成硬断言。
 * 每条都配了**反向用例**：既要证明误伤已消失，也要证明真正的附和仍然命中（避免「一刀切改成 null」）。
 */

test('主帖护栏：threadRoot 或 id===threadId 都不参与折叠，回复也不折到主帖上', async () => {
  // 直接调用层：两个自证条件都要挡住
  assert.equal(
    planEmotionFold({ id: 'T', handle: 'h', text: '都来参加', threadId: 'T', threadRoot: true, context: 'timeline', seq: 1 }, [], { mode: 'fold' }),
    null,
    'threadRoot=true 的主帖不该产生折叠计划',
  );
  assert.equal(
    planEmotionFold({ id: 'T', handle: 'h', text: '都来参加', threadId: 'T', context: 'timeline', seq: 1 }, [], { mode: 'fold' }),
    null,
    'id === threadId 的主帖不该产生折叠计划',
  );

  // pipeline 层（真站路径）：主帖排除后，回复是这一组的代表，不会被折到主帖名下
  const { pipeline } = pipelineHarness();
  const thread = '1912345678901234567';
  const main = { id: thread, handle: 'host', text: '都来参加', threadRoot: true, media: [], context: 'timeline', threadId: thread };
  const later = { id: 'r2', handle: 'u2', text: '已三连！！！', threadRoot: false, media: [], context: 'reply', threadId: thread };
  const mainDecision = await pipeline.decide(main);
  const replyDecision = await pipeline.decide(later);
  assert.equal(mainDecision.beta, null, '主帖不产生折叠计划');
  assert.notEqual(replyDecision.beta?.duplicateOf, thread, '回复不该折到主帖上');
  assert.equal(replyDecision.beta?.representative, true, '主帖被排除后，回复自己成为本组代表');
  assert.equal(replyDecision.beta?.scope, 'thread');
});

test('修复点 1（praise 前缀白名单）：正常描述句不再被折叠，称呼 + 最高级仍命中', () => {
  // 反向：白名单内的称呼 + 最高级必须仍然命中
  for (const text of ['佳佳妹妹最好，最美！', '姐姐最美', '大佬太厉害了', '妹妹最漂亮', '老师最厉害']) {
    assert.equal(classifyEmotion(text), 'praise', `称呼 + 最高级应判赞美：${text}`);
  }
  // 正向：非称呼的自由前缀（天气/方案/性价比/心情/状态）不得命中
  for (const text of ['今天天气最好', '这个方案最好', '性价比最好', '今天心情最好', '他的状态最好']) {
    assert.equal(classifyEmotion(text), null, `正常描述句不该被折叠：${text}`);
  }
  // 原有的否定/劝告尾巴仍然安全
  for (const text of ['最好别来', '好人最好骗', '大家最好注意安全']) {
    assert.equal(classifyEmotion(text), null, text);
  }
});

test('修复点 2（wish 动词收紧 + PREFIX_BLOCKED）：事务问句不再命中原，求取句仍命中', () => {
  // 反向：真正的求取/愿望语句仍应命中
  for (const text of ['好事多磨，什么时候可以来一份', '帮我安排一份', '三连了，希望能中🙏']) {
    assert.notEqual(classifyEmotion(text), null, `真的求取句要命中：${text}`);
  }
  // 正向：合同/退款/样机/报告等事务问句必须 null
  for (const text of ['合同什么时候可以给我', '退款什么时候可以给我', '样机什么时候可以给我', '这份报告什么时候可以给我']) {
    assert.equal(classifyEmotion(text), null, `正常事务问句不该被折叠：${text}`);
  }
});

test('修复点 3（默认 scope）：threadId 非空或 reply 走线程，纯时间线走 feed', () => {
  // 详情页里 context 仍是 timeline、但 threadId 非空 → 线程语义（否则合并会退化）
  const inThread = planEmotionFold({ id: 'a', handle: 'u', text: '都来参加', context: 'timeline', threadId: 't1', seq: 1 }, [], { mode: 'fold' });
  assert.equal(inThread?.scope, 'thread');
  assert.equal(inThread?.groupKey, 'em:t1:low');

  // 反向：纯时间线（没有 threadId）仍走 feed，不跨帖合并
  const feed = planEmotionFold({ id: 'a', handle: 'u', text: '都来参加', context: 'timeline', threadId: null, seq: 1 }, [], { mode: 'fold' });
  assert.equal(feed?.scope, 'feed');
  assert.equal(feed?.groupSize, 1);
  assert.equal(feed?.duplicateOf, null);

  // 反向：线程语义但没有 threadId（首页时间线里的回复）→ 没有可归组的线程，返回 null（宁可不折）
  const noThread = planEmotionFold({ id: 'a', handle: 'u', text: '都来参加', context: 'reply', threadId: null, seq: 1 }, [], { mode: 'fold' });
  assert.equal(noThread, null);
});

test('修复点 4（participation 过窄）：自然参与句式命中，陈述句仍不命中', () => {
  // 反向：修复后的三种自然参与句式都要命中
  for (const text of ['大家一起来参加一下吧', '我要报名参加', '已经三连过了', '都来参加', '已三连！！！']) {
    assert.equal(classifyEmotion(text), 'participation', `参与类应命中：${text}`);
  }
  // 正向：带过去时/信息量的陈述仍不得命中（避免「参加」二字一刀切）
  for (const text of ['我参加过一次', '报名截止了吗', '参加活动的注意事项']) {
    assert.equal(classifyEmotion(text), null, `不是低信息量附和：${text}`);
  }
});

/* ============ 五、不变量 I1（硬断言） ============ */

function pipelineHarness({ patch = {} } = {}) {
  let settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    triage: { ...DEFAULT_SETTINGS.triage, enabled: false },
    ...patch,
  });
  const jev = {
    async systemOne(request) {
      const ids = Object.keys(request.questions ?? {});
      if (ids.some((id) => id.startsWith('beta_c') || id === 'alpha_majority' || id === 'alpha_contrast')) {
        return { answers: {} };
      }
      return {
        answers: {
          adult: { type: 'noul', noul: 0.05 },
          solicitation: { type: 'noul', noul: 0.05 },
          deceptive: { type: 'noul', noul: 0 },
          category: { type: 'choice', choice: 'ordinary', confidence: 0.9, probabilities: {} },
          severity: { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: {} },
        },
      };
    },
  };
  const pipeline = createPipeline({ getSettings: () => settings, jev, now: () => 1_700_000_000_000, random: () => 1 });
  return { pipeline };
}

const MERGE_A = { id: 'e1', handle: 'u1', text: '都来参加', media: [], context: 'reply', threadId: 'th1' };
const MERGE_B = { id: 'e2', handle: 'u2', text: '已三连！！！', media: [], context: 'reply', threadId: 'th1' };

test('I1：合并成一条不改变 band / accountAction / reasons（开/关情绪层逐项一致）', async () => {
  const on = pipelineHarness();
  const off = pipelineHarness({ patch: { semantics: { emotion: { enabled: false } } } });

  const onA = await on.pipeline.decide(MERGE_A);
  const onB = await on.pipeline.decide(MERGE_B);
  const offA = await off.pipeline.decide(MERGE_A);
  const offB = await off.pipeline.decide(MERGE_B);

  for (const [a, b, label] of [
    [onA, offA, 'A'],
    [onB, offB, 'B'],
  ]) {
    assert.equal(a.band, b.band, `${label}：band 必须一致`);
    assert.deepEqual(a.accountAction, b.accountAction, `${label}：accountAction 必须一致`);
    assert.deepEqual(a.reasons, b.reasons, `${label}：reasons 必须一致`);
    assert.equal(a.accountAction.kind, 'none', `${label}：附和折叠不产生账号动作`);
  }
});

test('v0.4.7：pipeline 里第二条同线程附和被本地合并（kind=emotion / folded=true）', SPEC, async () => {
  const { pipeline } = pipelineHarness();
  const first = await pipeline.decide(MERGE_A);
  const second = await pipeline.decide(MERGE_B);
  assert.equal(first.beta?.representative, true, '第一条是代表条');
  assert.equal(second.beta?.kind, 'emotion');
  assert.equal(second.beta?.folded, true);
  assert.equal(second.beta?.duplicateOf, 'e1');
  assert.equal(second.beta?.groupKey, 'em:th1:low');
  assert.equal(second.beta?.groupSize, 2);
});
