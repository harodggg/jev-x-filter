/**
 * 本地隐藏/折叠路径的**独立误伤审计**（task-8，对抗性验证）。
 *
 * 审计对象（只读 src/，不改任何实现）：
 * 1. `prefilter.js` 的强规则 `zh_body_euphemism`（只入身体 / 不入生活）与 `zh_meme_fuli`
 *    （玩归玩闹归闹 + 看福/看福利），以及 `preScreen().reviewFloor`（新闻语境降级后必须为 false）；
 * 2. `gate.js` 的 review 下限（`signals.reviewFloor` → band=review / reason=solicit_template，绝不动账号）；
 * 3. `lowSignal.js` v0.4.4 情绪分类器 `classifyEmotion()` 与 `planEmotionFold()`。
 *
 * 目标：**找「正常内容被隐藏/折叠」的误伤**。发现问题不改 src，写成 `{ todo: true }` 用例
 * （node:test 里 todo 失败不会让 `node --test tests/` 变红，但会出现在 todo 计数里），
 * 每条注明「期望 / 实际 / 最小复现 / 建议口径」。过窄（该折叠的没折叠）同样用 todo 记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';
import { STRONG_RULES, preScreen, matchRules } from '../src/sw/prefilter.js';
import { decide, planAccountAction } from '../src/sw/gate.js';
import {
  LOW_SIGNAL_MAX_CHARS,
  classifyEmotion,
  classifyLowSignal,
  emotionLabel,
  planEmotionFold,
  planLowSignalFold,
} from '../src/sw/lowSignal.js';
import { createPipeline } from '../src/sw/pipeline.js';

const SETTINGS = normalizeSettings(DEFAULT_SETTINGS);
const tweet = (text, extra = {}) => ({ handle: 'normaluser', text, media: [], context: 'timeline', ...extra });

/** 普通推文的模型答案（类别 ordinary、置信度低）——闸门不该仅凭本地模板就隐藏它。 */
const ORDINARY_ANSWERS = {
  adult: { type: 'noul', noul: 0.05 },
  solicitation: { type: 'noul', noul: 0.05 },
  deceptive: { type: 'noul', noul: 0 },
  category: { type: 'choice', choice: 'ordinary', confidence: 0.9, probabilities: { ordinary: 0.9 } },
  severity: { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: {} },
};

/* ==================== 一、prefilter：本地模板规则的误伤 ==================== */

test('审计对象存在：两条模板规则都带 reviewFloor 元数据', () => {
  const byId = Object.fromEntries(STRONG_RULES.map((r) => [r.id, r]));
  assert.equal(byId.zh_body_euphemism?.reviewFloor, true);
  assert.equal(byId.zh_meme_fuli?.reviewFloor, true);
  assert.equal(byId.zh_body_euphemism?.sexual, true);
  assert.equal(byId.zh_meme_fuli?.sexual, true);
});

test('真话术必须仍被抓住：只入身体 / 玩归玩闹归闹 + 看福', () => {
  for (const text of ['只入身体🥦🌰不入生活', '只入身体🦵💪不入生活', '只进入身体，不入生活']) {
    const r = preScreen(tweet(text), SETTINGS);
    assert.equal(r.reviewFloor, true, `应命中 reviewFloor：${text}`);
    assert.equal(r.candidate, true);
    assert.ok(r.reasons.includes('zh_body_euphemism'));
  }
  const meme = preScreen(tweet('玩归玩闹归闹🌹🍷给你看福👍我不开玩笑'), SETTINGS);
  assert.equal(meme.reviewFloor, true);
  assert.ok(meme.reasons.includes('zh_meme_fuli'));
});

test('新闻/治理语境里引用这些黑话 → reviewFloor=false（不隐藏引用者）', () => {
  const quotes = [
    '警方通报：某平台用「只入身体不入生活」话术招嫖，已查处多个窝点',
    '法院判决：以「不入生活」为暗语招嫖的账号被封禁',
    '专项行动打击使用「只入身体」话术的引流账号',
  ];
  for (const text of quotes) {
    const r = preScreen(tweet(text), SETTINGS);
    assert.equal(r.newsContext, true, `应识别为新闻语境：${text}`);
    assert.equal(r.reviewFloor, false, `引用不该被本地模板隐藏：${text}`);
    // 组合规则仍未降级命中，只是权重 1；只写半句时命中弱规则 zh_body_weak（同样 1 分）。
    assert.ok(r.reasons.includes('zh_body_euphemism') || r.reasons.includes('zh_body_weak'), '规则仍命中，只是权重被降级');
    assert.ok(r.score <= 2, `降级后权重应为 1（每条规则），实际 ${r.score}`);
  }
});

test('正常「身体」语义不会被当成引流黑话', () => {
  for (const text of [
    '今天去做身体检查，结果一切正常',
    '每天坚持锻炼身体，精神状态好多了',
    '下周入职体检，有点紧张',
    '医生提醒：这种病毒只入侵身体的黏膜细胞，不进入血液',
  ]) {
    const r = preScreen(tweet(text), SETTINGS);
    assert.equal(r.reviewFloor, false, text);
    assert.equal(r.reasons.includes('zh_body_euphemism'), false, text);
    assert.equal(r.candidate, false, `不该成为候选：${text}`);
  }
});

test('正常「福利」语义不会变成候选或 reviewFloor', () => {
  for (const text of ['公司员工福利还不错，五险一金都有', '社保福利政策解读，别错过', '周末去福利院做志愿者', '今晚看福彩开奖，希望能中个奖']) {
    const r = preScreen(tweet(text), SETTINGS);
    assert.equal(r.reviewFloor, false, text);
    assert.equal(r.candidate, false, `只有弱特征时不该成为候选：${text}（score=${r.score}）`);
    assert.equal(r.reasons.includes('zh_meme_fuli'), false, text);
  }
});

test('大众梗「玩归玩闹归闹」单独出现不命中（组合规则的下限）', () => {
  const r = preScreen(tweet('玩归玩闹归闹，别拿安全开玩笑'), SETTINGS);
  assert.equal(r.reviewFloor, false);
  assert.equal(r.candidate, false);
  assert.equal(r.reasons.includes('zh_meme_fuli'), false);
});

/* ==================== 二、gate：review 下限的边界 ==================== */

test('gate：reviewFloor + 普通模型答案 → review/待确认，绝不进入 block', () => {
  const d = decide(ORDINARY_ANSWERS, { reviewFloor: true, prefilterScore: 3 }, SETTINGS);
  assert.equal(d.band, 'review');
  assert.ok(d.reasons.includes('solicit_template'));
  assert.equal(d.band === 'block', false);
});

test('gate：没有 reviewFloor 时，同一份普通答案不会隐藏', () => {
  const d = decide(ORDINARY_ANSWERS, { reviewFloor: false, prefilterScore: 3 }, SETTINGS);
  assert.equal(d.band, 'ignore');
  assert.deepEqual(d.reasons, []);
});

test('gate：全部类别关闭时 reviewFloor 不再隐藏（用户关掉的类别不被本地模板绕过）', () => {
  const off = normalizeSettings({
    ...DEFAULT_SETTINGS,
    categories: { adult: { enabled: false }, scam: { enabled: false }, ad_spam: { enabled: false }, clickbait: { enabled: false }, low_quality: { enabled: false }, farm: { enabled: false } },
  });
  const d = decide(ORDINARY_ANSWERS, { reviewFloor: true, prefilterScore: 3 }, off);
  assert.equal(d.band, 'ignore');
});

test('gate：reviewFloor 永远不规划账号动作（I1）', () => {
  const d = decide(ORDINARY_ANSWERS, { reviewFloor: true, prefilterScore: 3 }, SETTINGS);
  const action = planAccountAction({ band: d.band, settings: SETTINGS, budgetRemaining: 99, handle: 'normaluser' });
  assert.equal(action.kind, 'none');
  assert.equal(action.execute, false);
});

test('新闻语境降级后，即使模型给普通答案也不会被隐藏（端到端链路一致性）', () => {
  const r = preScreen(tweet('警方通报：某平台用「只入身体不入生活」话术招嫖，已查处多个窝点'), SETTINGS);
  const d = decide(ORDINARY_ANSWERS, { reviewFloor: r.reviewFloor, prefilterScore: r.score }, SETTINGS);
  assert.equal(r.reviewFloor, false);
  assert.equal(d.band, 'ignore');
});

/* ==================== 三、情绪分类器：误伤与过窄 ==================== */

test('情绪正例：各自的类别都要命中（交叉检查分类器是否过窄）', () => {
  const positives = [
    ['生气', 'anger'],
    ['太离谱了', 'anger'],
    ['无语了', 'anger'],
    ['哈哈', 'joy'],
    ['笑死', 'joy'],
    ['支持', 'support'],
    ['认同', 'support'],
    ['有道理', 'support'],
    ['不同意', 'oppose'],
    ['不行', 'oppose'],
    ['算了吧', 'oppose'],
    ['难过', 'sadness'],
    // v0.4.8：confirmation 并入 support（用户要求「最多 10 类」）
    ['确实', 'support'],
    ['确定', 'support'],
    ['确认', 'support'],
    ['😂😂', 'emoji'],
    ['😀', 'emoji'],
    ['哈哈哈哈', 'joy'],
    ['可以的', 'support'],
    ['好的', 'support'],
    ['收到', 'support'],
  ];
  for (const [text, expected] of positives) {
    assert.equal(classifyEmotion(text), expected, `${JSON.stringify(text)} 应归为 ${expected}`);
  }
});

test('情绪反例：讲理由/带论据的回复一律不是情绪（折叠的是情绪，不是论点）', () => {
  for (const text of [
    '我不同意，公开数据其实是反过来的',
    '反对这个方案，因为成本太高了',
    '不同意，但前提是数据要公开',
    '我觉得这个政策还有改进空间，应该多听听一线意见',
    '这是一份很长的评论，主要讲了三件事：成本、执行、风险，所以我反对',
  ]) {
    assert.equal(classifyEmotion(text), null, `讲理由的回复不该被折叠：${text}`);
  }
});

test('情绪反例：疑问句 / 带数字 / 带链接 / 讲事情的长文本', () => {
  for (const text of ['这是什么意思？', '为什么这么说？', '支持 2024 年的方案', '支持 https://x.com/abc', '不行 3 个点了']) {
    assert.equal(classifyEmotion(text), null, text);
  }
  // v0.4.8 三层长度：核心 ≤12 / 模板 ≤20 / **覆盖率 ≤60**。
  // 所以「纯附和的长句」在 60 字内仍会命中（覆盖率 ≥0.7），但「讲事情的长句」必须 null。
  assert.equal(classifyEmotion('已经报名了坐等开奖'), 'participation', '13 字纯附和走覆盖率应命中');
  assert.equal(classifyEmotion('支持'.repeat(20)), 'support', '40 字纯附和（≤60、覆盖率足够）应命中');
  assert.equal(classifyEmotion('支持'.repeat(31)), null, '超过 60 字不再走覆盖率');
  assert.equal(classifyEmotion('很好的活动我非常喜欢这个周边真的很棒棒棒棒棒棒棒棒棒棒'), null, '长句覆盖率不足 → null');
});

test('情绪边界：v0.4.8 三层长度（核心≤12 / 模板≤20 / 覆盖率≤60，覆盖率需 ≥0.7）', () => {
  const twelve = '支持支持支持支持支持支持';
  assert.equal([...twelve].length, LOW_SIGNAL_MAX_CHARS);
  assert.equal(classifyEmotion(twelve), 'support', '12 字核心路径');
  // 13 字不再一刀切：纯附和（覆盖率足够）命中，带实质词/否决词的 null
  assert.equal(classifyEmotion(`${twelve}支`), 'support', '13 字纯附和走覆盖率');
  assert.equal(classifyEmotion('已经报名了但没有时间'), null, '实质词 时间 → null');
  assert.equal(classifyEmotion('已经报名了别催了'), null, '否决词 别 → null');
});

test('情绪边界：空串 / 标点 / 箭头 / 拉丁字母不是情绪，纯 emoji 是 emoji', () => {
  for (const text of ['', '   ', '？', '！', '。。。', '→', 'a', 'ok', 'haha']) {
    assert.equal(classifyEmotion(text), null, `${JSON.stringify(text)} 不该是情绪`);
  }
  assert.equal(classifyEmotion('😭😭'), 'emoji');
  assert.equal(classifyEmotion('😂 好的'), 'support', 'emoji + 文本时以文本判定');
  assert.equal(classifyEmotion('😂 我不同意'), 'oppose');
});

test('情绪反例：含核心短语子串的正常词/句不会被误伤', () => {
  for (const text of [
    '垃圾分类从我做起，今天你分了吗',
    '操场上有很多人在跑步',
    '赞助商提供了很多帮助',
    '他们来了',
    '公司福利不错，五险一金都有',
    '我的',
    '人们',
    '人渣',
    '到底行不行',
  ]) {
    assert.equal(classifyEmotion(text), null, `正常内容不该被判成情绪：${text}`);
  }

  // v0.4.5 有意扩展：这几个**单独成句**时就是附和/赞美（回复区里属于情绪言论）；
  // 只要它们出现在句子中间（如上一条的「公司福利不错，五险一金都有」），整串匹配不上 → 依然 null。
  assert.equal(classifyEmotion('不错'), 'praise');
  assert.equal(classifyEmotion('真不错'), 'praise');
  assert.equal(classifyEmotion('好吧'), 'support');
});

test('旧名兼容：classifyLowSignal 只保留 agreement / emotion 两种输出', () => {
  assert.equal(classifyLowSignal('支持'), 'agreement');
  assert.equal(classifyLowSignal('认同'), 'agreement');
  // v0.4.8：confirmation 并入 support，旧名映射到 agreement（不再有 confirmation 输出）
  assert.equal(classifyLowSignal('确实'), 'agreement');
  assert.equal(classifyLowSignal('确定'), 'agreement');
  assert.equal(classifyLowSignal('哈哈'), 'emotion');
  assert.equal(classifyLowSignal('生气'), 'emotion');
  assert.equal(classifyLowSignal('我不同意，因为成本太高'), null);
});

/* ==================== 四、planEmotionFold：归组语义 ==================== */

// v0.4.5 起：时间线/推荐流（无 context: reply）走 feed 范围（每条各自折叠），
// 线程用例必须显式带 context: 'reply'。
const recentEntry = (id, text, seq, threadId = 't1') => ({ id, handle: `u${id}`, text, seq, ts: seq, threadId, context: 'reply' });

test('fold：第一条是代表条（不折叠），后续任意类别都折叠到最早的条目', () => {
  const first = planEmotionFold(recentEntry('a', '支持', 1), [], { mode: 'fold' });
  assert.deepEqual(
    { representative: first.representative, folded: first.folded, duplicateOf: first.duplicateOf, groupSize: first.groupSize, kind: first.kind, emotion: first.emotion },
    { representative: true, folded: false, duplicateOf: null, groupSize: 1, kind: 'emotion', emotion: 'support' },
  );

  // v0.4.7：线程内不再按类别分组 —— 不同类别（支持 + 喜悦）也合并到同一条代表
  const second = planEmotionFold(recentEntry('b', '哈哈', 2), [recentEntry('a', '支持', 1)], { mode: 'fold' });
  assert.equal(second.representative, false);
  assert.equal(second.folded, true);
  assert.equal(second.duplicateOf, 'a');
  assert.equal(second.duplicateOfHandle, 'ua');
  assert.equal(second.groupSize, 2);
  assert.equal(second.groupKey, 'em:t1:low', 'v0.4.7 起 groupKey 是线程级单组，不含类别');
  assert.equal(second.emotion, 'joy', '本条自己的类别仍然照实给出');
  assert.equal(second.emotionLabel, '喜悦');
  assert.equal(second.merged, '低信息量附和', '多条合并时给出总标签');
  assert.deepEqual(second.classes, { support: 1, joy: 1 });
});

test('fold：只按比本条更早的观察顺序（seq）归组，乱序不影响代表条', () => {
  const recent = [recentEntry('a', '支持', 1), recentEntry('b', '支持', 2), recentEntry('c', '支持', 3)];
  const middle = planEmotionFold(recentEntry('b', '支持', 2), recent, { mode: 'fold' });
  assert.equal(middle.groupSize, 2, '只看 seq 更早的 a');
  assert.equal(middle.duplicateOf, 'a');
  assert.equal(middle.folded, true, 'b 已经被 a 代表，应折叠');
});

test('不同线程不互相归组；同线程不同类别合并到同一条代表', () => {
  const recent = [recentEntry('a', '支持', 1, 't1'), recentEntry('x', '支持', 2, 't2'), recentEntry('j', '哈哈', 3, 't1')];

  // 另一个线程里没有更早的附和 → 不归组（其他线程不能跨线程折叠它）
  const otherThread = planEmotionFold(recentEntry('y', '支持', 4, 't3'), recent, { mode: 'fold' });
  assert.equal(otherThread.groupSize, 1);
  assert.equal(otherThread.representative, true);
  assert.equal(otherThread.duplicateOf, null);

  // v0.4.7：同线程不同类别（悲伤 vs 支持/喜悦）**应当合并**到同一条代表，但本条 emotion 仍照实给
  const otherClass = planEmotionFold(recentEntry('k', '难过', 5, 't1'), recent, { mode: 'fold' });
  assert.equal(otherClass.groupKey, 'em:t1:low', '线程级单组');
  assert.equal(otherClass.groupSize, 3, '同线程不同类别也要合并');
  assert.equal(otherClass.duplicateOf, 'a', '代表条是该线程最早的那条');
  assert.equal(otherClass.folded, true);
  assert.equal(otherClass.emotion, 'sadness', '本条自己的类别仍然正确');
  assert.equal(otherClass.merged, '低信息量附和');
  assert.deepEqual(otherClass.classes, { support: 1, joy: 1, sadness: 1 });

  // 同线程再来一条喜悦 → 归到同一条代表，组内合计 4（含上面那条悲伤）
  const sameClass = planEmotionFold(recentEntry('m', '哈哈', 6, 't1'), [...recent, recentEntry('k', '难过', 5, 't1')], { mode: 'fold' });
  assert.equal(sameClass.groupSize, 4);
  assert.equal(sameClass.duplicateOf, 'a');
  assert.equal(sameClass.folded, true);
  assert.equal(sameClass.emotion, 'joy');
});

test('hide 模式：同线程同类全部折叠（连代表条也不留）', () => {
  const recent = [recentEntry('a', '支持', 1), recentEntry('b', '支持', 2)];
  const plan = planEmotionFold(recentEntry('c', '支持', 3), recent, { mode: 'hide' });
  assert.equal(plan.mode, 'hide');
  assert.equal(plan.representative, false);
  assert.equal(plan.folded, true);
  assert.equal(plan.groupSize, 3);

  const solo = planEmotionFold(recentEntry('a', '支持', 1), [], { mode: 'hide' });
  assert.equal(solo.folded, true, 'hide 模式下第一条也要折叠');
  assert.equal(solo.representative, false);
});

test('无 threadId 的情绪走 feed 范围（各自折叠）；非情绪文本仍然 null', () => {
  const feed = planEmotionFold({ id: 'z', text: '支持', threadId: null }, [], { mode: 'fold' });
  assert.equal(feed?.scope, 'feed', '时间线没有线程语义 → 每条各自折叠 + 标类别');
  assert.equal(feed?.folded, true);
  assert.equal(feed?.groupSize, 1);
  assert.equal(planEmotionFold({ id: 'z', text: '我不同意，因为成本太高', threadId: 't1' }, [], { mode: 'fold' }), null, '论点不是情绪');
  assert.equal(planEmotionFold({ id: 'z', text: '我不同意，因为成本太高', threadId: null, context: 'timeline' }, [], { mode: 'fold' }), null);
});

test('旧名 planLowSignalFold 等价于 fold 模式；emotionLabel 是中文', () => {
  const target = recentEntry('b', '支持', 2);
  const legacy = planLowSignalFold(target, [recentEntry('a', '支持', 1)]);
  assert.equal(legacy.folded, true);
  assert.equal(legacy.mode, 'fold');
  assert.equal(planEmotionFold(target, [recentEntry('a', '支持', 1)], { mode: 'fold' }).groupKey, legacy.groupKey);
  assert.equal(emotionLabel('anger'), '愤怒');
  assert.equal(emotionLabel('emoji'), '表情');
});

/* ==================== 五、不变量 I1：情绪折叠不改 band / accountAction ==================== */

function emotionHarness({ patch = {} } = {}) {
  let settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    triage: { ...DEFAULT_SETTINGS.triage, enabled: false },
    ...patch,
  });
  const calls = [];
  const jev = {
    async systemOne(request) {
      calls.push(request);
      const ids = Object.keys(request.questions ?? {});
      if (ids.some((id) => id.startsWith('beta_c') || id === 'alpha_majority' || id === 'alpha_contrast')) {
        return { answers: {} }; // 语义层不折叠 → 走本地情绪分支
      }
      return { answers: ORDINARY_ANSWERS };
    },
  };
  const pipeline = createPipeline({ getSettings: () => settings, jev, now: () => 1_700_000_000_000, random: () => 1 });
  return { pipeline, calls };
}

// 用 4 个字符的情绪短语：预筛的 minTextLength=4 会把「支持/认同」(2 字) 当 too_short 跳过，
// 那样根本走不到本地折叠分支 —— 这里要测的是折叠路径本身。
const REPLY_A = { id: 'r1', handle: 'u1', text: '支持支持', media: [], context: 'reply', threadId: 'th1' };
const REPLY_B = { id: 'r2', handle: 'u2', text: '认同认同', media: [], context: 'reply', threadId: 'th1' };

test('I1：同一线程第二条同类情绪被本地折叠，band/accountAction 与关闭情绪层时完全一致', async () => {
  const on = emotionHarness();
  const off = emotionHarness({ patch: { semantics: { emotion: { enabled: false } } } });

  const onFirst = await on.pipeline.decide(REPLY_A);
  const onSecond = await on.pipeline.decide(REPLY_B);
  const offFirst = await off.pipeline.decide(REPLY_A);
  const offSecond = await off.pipeline.decide(REPLY_B);

  assert.equal(onFirst.beta?.representative, true, '第一条是代表条（不折叠）');
  assert.equal(onSecond.beta?.kind, 'emotion');
  assert.equal(onSecond.beta?.folded, true);
  assert.equal(onSecond.beta?.duplicateOf, 'r1');
  assert.equal(onSecond.beta?.groupSize, 2);
  assert.equal(offSecond.beta, null, '关掉情绪层后不再折叠');

  for (const [a, b, label] of [
    [onFirst, offFirst, '第一条'],
    [onSecond, offSecond, '第二条'],
  ]) {
    assert.equal(a.band, b.band, `${label}：band 必须一致`);
    assert.deepEqual(a.accountAction, b.accountAction, `${label}：accountAction 必须一致`);
    assert.deepEqual(a.reasons, b.reasons, `${label}：reasons 必须一致`);
  }
  assert.equal(on.pipeline.stats().semantics.betaFolds >= 2, true, '折叠计数走既有 betaFolds');
});

test('I1：本地情绪折叠不产生任何账号动作（review/ignore 档）', async () => {
  const { pipeline } = emotionHarness();
  await pipeline.decide(REPLY_A);
  const decision = await pipeline.decide(REPLY_B);
  assert.equal(decision.accountAction.kind, 'none');
  assert.equal(decision.accountAction.execute, false);
});

/* ==================== 六、发现的误伤 / 过窄（todo 记录，不弄红套件） ====================
 * node:test 的 todo 用例失败不会让 `node --test tests/` 变红（fail 仍为 0），
 * 但会出现在 todo 计数里 —— 缺陷必须被记录，而不是被静默吞掉。
 * 修复后去掉 `{ todo: true }` 即成为硬断言。
 */

test('误伤 1（已修）：正常生活建议里的「不入生活」不再被当成引流黑话', () => {
  // 期望：reviewFloor === false（这是正常中文表达，不是招嫖黑话）
  // 实际：true —— `zh_body_euphemism` 的第二分支是裸片段 `/不入生活/`
  // 最小复现：preScreen({ text: '人到中年别只顾工作，不入生活，健康和家人才最重要' }) → reviewFloor true
  // 影响：band=review（对用户是「被隐藏」），模型说 ordinary 也没用
  // 建议口径：把两个分支绑成组合规则（如 `只(?:入|进入|进)身体[\s\S]{0,12}不入生活`），
  //           或要求同时出现交易/身体语义；至少别把「不入生活」当独立定罪片段
  const r = preScreen(tweet('人到中年别只顾工作，不入生活，健康和家人才最重要'), SETTINGS);
  assert.equal(r.reviewFloor, false, '正常生活建议不该被本地模板隐藏');
});

test('误伤 2（已修）：钩子不再命中 福建/福彩 等正常词', () => {
  // 期望：reviewFloor === false（「玩归玩闹归闹，别拿安全开玩笑」是大众梗，后面跟的是福建舰新闻）
  // 实际：true —— `zh_meme_fuli` 的钩子是裸 `看福`，`我想看福建舰` 里的 `看福` 命中
  // 最小复现：preScreen({ text: '玩归玩闹归闹，别拿安全开玩笑，我想看福建舰下水' }) → reviewFloor true
  // 建议口径：钩子收紧成 `给你看福(?:利)?|看福利` 并排除 `看福(?:建|彩|州|岛|田)`，
  //           或要求「给/让/来 + 看福利」这类施动结构
  const r = preScreen(tweet('玩归玩闹归闹，别拿安全开玩笑，我想看福建舰下水'), SETTINGS);
  assert.equal(r.reviewFloor, false, '大众梗 + 福建（正常地名）不该被判成引流模板');
});

test('误伤 3（已修）：科普/医学语境引用黑话一律降级', () => {
  // 期望：reviewFloor === false（和「警方通报…」一样，引用者不该被隐藏）
  // 实际：true —— NEWS_CONTEXT 只收录 警方|通报|法院|…|辟谣|警示 等，没有「科普/医学/医生/论文/记者/调查」
  // 最小复现：preScreen({ text: '科普：这些话术（只入身体、不入生活）是不法分子的引流模板，别信' }) → reviewFloor true
  // 建议口径：把 科普|医学|医生|论文|疾控|记者|调查|反诈|防骗|提醒 加进 NEWS_CONTEXT
  const r = preScreen(tweet('科普：这些话术（只入身体、不入生活）是不法分子的引流模板，别信'), SETTINGS);
  assert.equal(r.reviewFloor, false, '科普引用不该被本地模板隐藏');
});

test('过窄已修 1：加了语气/主语的短情绪句不再漏判', () => {
  // 期望：`我服了` → anger（`服了` 本身在 anger 核心表里）
  // 实际：null —— stripFillers 先削掉头部「我」，尾部「了」跟着被削掉，核心「服了」被削成「服」
  // 最小复现：classifyEmotion('我服了') === null；classifyEmotion('服了') === 'anger'
  // 建议口径：变体生成里保留「只削首或只削尾」的中间形态，或先匹配核心再做填充
  assert.equal(classifyEmotion('我服了'), 'anger');
});

test('过窄已修 2：程度补语（难过死了）不再漏判', () => {
  // 期望：sadness；实际：null（尾部「死了」不在填充表里，整串不等于核心「难过」）
  // 最小复现：classifyEmotion('难过死了') === null；classifyEmotion('难过') === 'sadness'
  // 建议口径：允许核心 + 程度补语（死了/爆了/到哭）的有限后缀
  assert.equal(classifyEmotion('难过死了'), 'sadness');
});

test('误伤 4（已修）：医学/理疗语境里的「只进入身体」不再被当成黑话', () => {
  // 期望：reviewFloor === false（「针只进入身体的浅层组织」是正常医学/理疗描述）
  // 实际：true —— `zh_body_euphemism` 的第一分支 `/只(?:入|进入|进)身体/` 只认字面，
  //       不区分「只进入身体的浅层」与「只入身体不入生活」的固定话术；
  //       NEWS_CONTEXT 里也没有 医学/医生/理疗/理疗 这类词来降级
  // 最小复现：preScreen({ text: '医生说明：这根针只进入身体的浅层组织，不会伤到神经' }) → reviewFloor true
  // 建议口径：两种走法 —— ① 把 医学|医生|理疗|临床|治疗|患者 加进 NEWS_CONTEXT（降级而非命中）；
  //           ② 把「只(入|进入|进)身体」收紧成与后半句共现的组合规则（如要求同句出现 不入生活/付费/联系）
  const r = preScreen(tweet('医生说明：这根针只进入身体的浅层组织，不会伤到神经'), SETTINGS);
  assert.equal(r.reviewFloor, false, '正常医学描述不该被本地模板隐藏');
});

test('未发现：正常短词/子串不会被误判成情绪（子串安全的回归护栏）', () => {
  // 这一条是**通过**的护栏：分类器要求「整串恰好是情绪短语（可带加强语/语气词）」，
  // 所以下面的正常词/句一律 null。若将来放宽成 includes，应当先让这条失败。
  for (const text of ['垃圾分类', '操场', '赞助商', '他们', '我的', '人们', '人渣', '关注一下这个政策的进展']) {
    assert.equal(classifyEmotion(text), null, `不该判成情绪：${text}`);
  }
});

test('未发现：`matchRules` 的降级只影响权重，不影响命中 id', () => {
  const normal = matchRules('警方通报：只入身体不入生活话术', { newsContext: false });
  const downgraded = matchRules('警方通报：只入身体不入生活话术', { newsContext: true });
  assert.equal(normal[0].weight, 3);
  assert.equal(downgraded[0].weight, 1);
  assert.equal(downgraded[0].id, normal[0].id);
});
