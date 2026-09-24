/**
 * α / β 语义层单测：候选筛选、一次调用的问题/state 形状、答案解析、预算与错误、
 * 以及最硬的不变量 I1 —— 语义层的任何结果都不改变 band / accountAction。
 *
 * 用假 Jev 客户端（零依赖、不联网）：按请求里问了什么 id 分流「过滤问题」与「语义问题」，
 * 和 pipeline.test.js 是同一套注入风格。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../src/sw/pipeline.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';
import {
  ALPHA_CONTRAST_ID,
  ALPHA_MAJORITY_ID,
  ALPHA_REASON,
  ALPHA_SUMMARY,
  CANDIDATE_MIN_SIMILARITY,
  SEMANTICS_KIND,
  buildSemanticsRequest,
  createRecentWindow,
  foldAllowed,
  pickBetaCandidates,
  planSemanticCall,
  readSemanticsAnswers,
  semanticSimilarity,
} from '../src/sw/semantics.js';
import { hash32 } from '../src/sw/util.js';

/* ------------------------------- 假客户端工具 ------------------------------- */

const noulAnswer = (noul) => ({ type: 'noul', noul });
const scoreAnswer = (score, confidence = 0.9) => ({ type: 'score', score, confidence, legend: {}, probabilities: {} });
const choiceAnswer = (choice, confidence = 0.9) => ({ type: 'choice', choice, confidence, probabilities: {} });

function filterAnswers({ adult = 0.1, sol = 0.1, dec = 0, cat = 'ordinary', conf = 0.4, sev = 2.5 } = {}) {
  return {
    adult: noulAnswer(adult),
    solicitation: noulAnswer(sol),
    deceptive: noulAnswer(dec),
    category: choiceAnswer(cat, conf),
    severity: scoreAnswer(sev),
  };
}

const ORDINARY_FILTER = filterAnswers({ adult: 0.05, cat: 'ordinary', conf: 0.2 });
const BLOCK_FILTER = filterAnswers({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.93, sev: 3.1 });

function isSemanticRequest(request) {
  const ids = Object.keys(request?.questions ?? {});
  return ids.some((id) => id.startsWith('beta_c') || id === ALPHA_MAJORITY_ID || id === ALPHA_CONTRAST_ID);
}

/**
 * 建一条流水线 + 假 Jev。
 * - `filter`：过滤问题的答案（对象或函数）；
 * - `semantics`：语义问题的答案（对象或函数）；`failSemantics` 让语义调用抛错；
 * - `filterDelay` / `semanticsDelay`：给假客户端加人为延迟（毫秒，按请求返回），
 *   用来模拟真实网络下「先发的那条模型往返更慢」的交错（并发缺陷回归要靠它）；
 * - 默认关掉预检，让「调用次数」只反映过滤/语义两条路径，断言更干净。
 */
function harness({
  patch = {},
  filter = ORDINARY_FILTER,
  semantics = () => ({}),
  failSemantics = false,
  filterDelay = () => 0,
  semanticsDelay = () => 0,
  now = () => 1_700_000_000_000,
} = {}) {
  let settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    triage: { ...DEFAULT_SETTINGS.triage, enabled: false },
    ...patch,
  });
  const calls = [];
  const jev = {
    calls,
    async systemOne(request) {
      calls.push(request);
      const semanticRequest = isSemanticRequest(request);
      const delay = semanticRequest ? semanticsDelay(request) : filterDelay(request);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (semanticRequest) {
        if (failSemantics) throw new Error('semantics 网关 503');
        const answers = typeof semantics === 'function' ? semantics(request) : semantics;
        return { model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      const answers = typeof filter === 'function' ? filter(request) : filter;
      return { model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const pipeline = createPipeline({ getSettings: () => settings, jev, now, random: () => 1 });
  return {
    pipeline,
    calls,
    semanticCalls: () => calls.filter(isSemanticRequest),
    filterCalls: () => calls.filter((request) => !isSemanticRequest(request)),
    setSettings: (next) => {
      settings = normalizeSettings({ ...settings, ...next });
    },
  };
}

/* --------------------------------- 固定样例 --------------------------------- */

const COFFEE_A = {
  id: 'b1',
  handle: 'ann',
  text: '这家咖啡店的手冲咖啡真的非常好喝，强烈推荐大家去试试。',
  media: [],
  context: 'timeline',
};
const COFFEE_B = {
  id: 'b2',
  handle: 'bob',
  // 只是换了个标点：归一化后与 A 完全一致 → verbatim
  text: '这家咖啡店的手冲咖啡真的非常好喝，强烈推荐大家去试试！',
  media: [],
  context: 'timeline',
};
const CAT_A = {
  id: 'c1',
  handle: 'catlover',
  text: '宠物医院说这只猫需要做手术，费用大概三千块。',
  media: [],
  context: 'timeline',
};
const CAT_B = {
  id: 'c2',
  handle: 'catlover2',
  // 本地 3-gram ≈0.67 → paraphrase
  text: '宠物医院说这只猫需要马上做手术，费用差不多三千块。',
  media: [],
  context: 'timeline',
};

/** 预筛强特征命中的样本（会走完整判定，用于预算对照）。 */
const SPAM_A = { id: 'spam0', handle: 'spammer', text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利', media: [], context: 'timeline' };
const SPAM_B = { id: 'spam1', handle: 'spammer', text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利', media: [], context: 'timeline' };

const THREAD_REFS = [
  { id: 'r1', handle: 'ann', text: '我觉得这部电影的结局很合理，主角本来就应该离开。', media: [], context: 'reply', threadId: 't1' },
  { id: 'r2', handle: 'bob', text: '同感，结局铺垫得很充分，离开是唯一合理的选择。', media: [], context: 'reply', threadId: 't1' },
  { id: 'r3', handle: 'cid', text: '我也觉得结局没问题，导演前面埋了伏笔。', media: [], context: 'reply', threadId: 't1' },
];
const DIVERGENT_REPLY = {
  id: 'r4',
  handle: 'dee',
  text: '完全不同意，这部电影的结局是彻头彻尾的失败，主角留下来才是唯一合理的收束。',
  media: [],
  context: 'reply',
  threadId: 't1',
};

const alphaAnswers = ({ majority = 0.93, contrast = 3, extra = {} } = {}) => ({
  [ALPHA_MAJORITY_ID]: noulAnswer(majority),
  [ALPHA_CONTRAST_ID]: scoreAnswer(contrast),
  ...extra,
});

/* =============================== 本地工具（纯函数） =============================== */

test('semanticSimilarity：归一化后完全一致 = 1，近似文本 ≥ 候选线，无关文本 = 0', () => {
  assert.equal(semanticSimilarity(COFFEE_A.text, COFFEE_B.text), 1, '标点/大小写不影响归一化');
  assert.ok(semanticSimilarity(CAT_A.text, CAT_B.text) >= CANDIDATE_MIN_SIMILARITY);
  assert.equal(semanticSimilarity(COFFEE_A.text, '今天天气不错，我们一起去公园散步吧。'), 0);
  assert.equal(semanticSimilarity('', COFFEE_A.text), 0);
  assert.equal(semanticSimilarity('', ''), 0);
});

test('foldAllowed：reply 看 foldInReplies，timeline/recommended 看 foldInFeed', () => {
  assert.equal(foldAllowed('timeline', { foldInFeed: true, foldInReplies: false }), true);
  assert.equal(foldAllowed('recommended', { foldInFeed: false, foldInReplies: true }), false);
  assert.equal(foldAllowed('reply', { foldInFeed: true, foldInReplies: false }), false);
  assert.equal(foldAllowed('reply', { foldInFeed: false, foldInReplies: true }), true);
  assert.equal(foldAllowed(undefined, {}), true, '缺字段按默认允许');
});

test('createRecentWindow：同 id 刷新到最近、超窗口裁剪、可热更新 windowSize', () => {
  const window = createRecentWindow({ maxSize: 3, now: () => 1000 });
  window.push({ id: 'a', text: 'a', handle: 'x' });
  window.push({ id: 'b', text: 'b', handle: 'x' });
  window.push({ id: 'a', text: 'a', handle: 'x' });
  assert.deepEqual(window.list().map((e) => e.id), ['b', 'a'], '同 id 只保留一份并挪到最近');
  window.push({ id: 'c', text: 'c', handle: 'x' });
  window.push({ id: 'd', text: 'd', handle: 'x' });
  assert.deepEqual(window.list().map((e) => e.id), ['a', 'c', 'd'], '超窗口裁掉最旧的一条');
  assert.equal(window.configure({ maxSize: 1 }), 1);
  assert.deepEqual(window.list().map((e) => e.id), ['d']);
  assert.equal(window.push(null), null);
  assert.equal(window.push({ id: null, text: '   ' }), null);
});

test('候选筛选：selfSeq 之后进入窗口的推文不作为折叠目标', () => {
  const settings = normalizeSettings(null);
  const window = createRecentWindow({ maxSize: 60, now: () => 1000 });
  window.push({ id: 'e1', handle: 'a', text: COFFEE_A.text, context: 'timeline' }); // 更早
  const self = window.push({ id: 's1', handle: 'c', text: COFFEE_B.text, context: 'timeline' }); // 自己
  window.push({ id: 'l1', handle: 'b', text: COFFEE_B.text, context: 'timeline' }); // 更晚（并发中先被看到）
  const target = { ...COFFEE_B, id: 's1' };

  const all = pickBetaCandidates(target, window.list(), settings, Number.POSITIVE_INFINITY);
  assert.deepEqual(all.map((c) => c.id), ['e1', 'l1'], '不传 selfSeq 时包含更晚的条目');
  const onlyEarlier = pickBetaCandidates(target, window.list(), settings, self.seq);
  assert.deepEqual(onlyEarlier.map((c) => c.id), ['e1'], '只折叠到比自己更早出现的推文');
});

test('buildSemanticsRequest：三段固定顺序；无候选/参考时 REFERENCES 写 (none)', () => {
  const request = buildSemanticsRequest({
    target: { id: 'x', handle: '@me', displayName: '我', text: '正文在这里', context: 'reply', threadId: 't7' },
    candidates: [],
    references: [],
    alpha: false,
  });
  assert.ok(request.state.startsWith('CANDIDATE:\n正文在这里\n'));
  assert.ok(request.state.includes('CANDIDATE_META:\nhandle=@me; display_name=我; position=reply; thread_id=t7'));
  assert.ok(request.state.includes('REFERENCES:\n(none)'));
  assert.deepEqual(request.questions, {}, '没有问题就不该发这次调用');
});

test('buildSemanticsRequest：候选在前（[1]..[N] 对应 beta_c1..cN），α 只加两个问题', () => {
  const request = buildSemanticsRequest({
    target: { id: 'x', handle: 'me', text: '当前推文', context: 'reply', threadId: 't7' },
    candidates: [
      { id: 'k1', handle: 'a', text: '候选一' },
      { id: 'k2', handle: 'b', text: '候选二' },
    ],
    references: [{ id: 'k3', handle: 'c', text: '仅参考' }],
    alpha: true,
  });
  assert.deepEqual(Object.keys(request.questions), ['beta_c1', 'beta_c2', ALPHA_MAJORITY_ID, ALPHA_CONTRAST_ID]);
  assert.equal(request.questions.beta_c1.type, 'noul');
  assert.equal(request.questions[ALPHA_MAJORITY_ID].type, 'noul');
  assert.equal(request.questions[ALPHA_CONTRAST_ID].type, 'score');
  assert.equal(request.questions[ALPHA_CONTRAST_ID].criteria.length, 4, 'α 差异程度用 4 级');
  assert.ok(request.state.includes('[1] @a: 候选一'));
  assert.ok(request.state.includes('[2] @b: 候选二'));
  assert.ok(request.state.includes('[3] @c: 仅参考'));
  assert.ok(request.questions.beta_c1.instructions.includes('Reference [1]'));
  assert.ok(request.questions.beta_c2.instructions.includes('Reference [2]'));
});

/* =============================== β =============================== */

test('β：第一条无候选不调用；第二条相似才发一次调用并折叠到最早那条', async () => {
  const { pipeline, semanticCalls } = harness({
    semantics: () => ({ beta_c1: noulAnswer(0.91) }),
  });
  const first = await pipeline.decide(COFFEE_A);
  assert.equal(first.beta, null, '窗口里没有候选 → beta 为 null');
  assert.equal(semanticCalls().length, 0, '0 候选不调用模型');

  const second = await pipeline.decide(COFFEE_B);
  assert.equal(semanticCalls().length, 1, '只有相似的那条发了一次语义调用');
  assert.deepEqual(Object.keys(semanticCalls()[0].questions), ['beta_c1']);
  assert.deepEqual(second.beta, {
    duplicateOf: 'b1',
    groupKey: `bk_${hash32('这家咖啡店的手冲咖啡真的非常好喝强烈推荐大家去试试')}`,
    groupSize: 2,
    similarity: 0.91,
    kind: SEMANTICS_KIND.verbatim,
    folded: true,
  });
});

test('β：较低相似度（≥0.45）也会作为候选送模型', async () => {
  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.88) }) });
  await pipeline.decide(CAT_A);
  const decision = await pipeline.decide(CAT_B);
  assert.equal(semanticCalls().length, 1, '本地 3-gram ≥0.45 就送模型');
  const localSimilarity = semanticSimilarity(CAT_A.text, CAT_B.text);
  assert.ok(localSimilarity >= CANDIDATE_MIN_SIMILARITY && localSimilarity < 1);
  assert.equal(decision.beta.kind, SEMANTICS_KIND.paraphrase, '本地相似度 ≥0.6 → paraphrase');
  assert.equal(decision.beta.groupSize, 2);
});

test('β：同 threadId + 相似度 ≥0.30 → 仍是候选，kind 落到 same_claim', async () => {
  const sameThreadA = '这部电影的结局让我很失望，我觉得主角不该离开。';
  const sameThreadB = '这部电影的结局我觉得很好，主角离开是对的。';
  const local = semanticSimilarity(sameThreadA, sameThreadB);
  assert.ok(local >= 0.3 && local < 0.6, `样例相似度应落在 [0.30, 0.60)，实际 ${local}`);

  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.8) }) });
  await pipeline.decide({ id: 's1', handle: 'a', text: sameThreadA, media: [], context: 'reply', threadId: 't9' });
  const decision = await pipeline.decide({ id: 's2', handle: 'b', text: sameThreadB, media: [], context: 'reply', threadId: 't9' });
  assert.equal(semanticCalls().length, 1, '同 threadId 且 ≥0.30 才算候选');
  assert.equal(decision.beta.kind, SEMANTICS_KIND.same_claim);
});

test('β：同 threadId 但相似度 <0.30 的无关回复不入选（不花冤枉钱）', async () => {
  const unrelatedA = '这部电影的结局让我很失望，我觉得主角不该离开。';
  const unrelatedB = '这部电影结局很好，主角离开是对的。';
  assert.ok(semanticSimilarity(unrelatedA, unrelatedB) < 0.3);

  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.95) }) });
  await pipeline.decide({ id: 'u1', handle: 'a', text: unrelatedA, media: [], context: 'reply', threadId: 't4' });
  const decision = await pipeline.decide({ id: 'u2', handle: 'b', text: unrelatedB, media: [], context: 'reply', threadId: 't4' });
  assert.equal(semanticCalls().length, 0, '同一楼里的无关回复不该送模型');
  assert.equal(decision.beta, null);
  assert.equal(decision.detail.semantics.candidates, 0);
});

test('β：模型返回合法 choice 时 kind 以 choice 为准', async () => {
  const { pipeline } = harness({
    semantics: () => ({ beta_c1: { ...noulAnswer(0.9), choice: 'paraphrase' } }),
  });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(decision.beta.kind, SEMANTICS_KIND.paraphrase, '归一化后完全一致，但模型说是转述 → 听模型的');
});

test('β：答案低于阈值 → 不折叠（beta 为 null）', async () => {
  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.5) }) });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(semanticCalls().length, 1, '仍然问过模型');
  assert.equal(decision.beta, null);
  assert.equal(pipeline.stats().semantics.betaFolds, 0);
});

test('β：答案缺字段 / 非数字 → 不猜，beta 为 null', async () => {
  const { pipeline } = harness({ semantics: () => ({ beta_c1: { type: 'noul' } }) });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(decision.beta, null);
});

test('β：多个候选都确认时，duplicateOf 指向最早出现的那条，groupSize 含自己', async () => {
  const { pipeline, semanticCalls } = harness({
    semantics: () => ({ beta_c1: noulAnswer(0.9), beta_c2: noulAnswer(0.85) }),
  });
  await pipeline.decide({ ...COFFEE_A, id: 'old1', handle: 'old' });
  await pipeline.decide({ ...COFFEE_A, id: 'old2', handle: 'older' });
  const decision = await pipeline.decide({ ...COFFEE_B, id: 'new1', handle: 'new' });
  assert.deepEqual(Object.keys(semanticCalls().at(-1).questions), ['beta_c1', 'beta_c2']);
  assert.equal(decision.beta.duplicateOf, 'old1', '最早的是 old1（先进入窗口）');
  assert.equal(decision.beta.groupSize, 3);
  assert.equal(decision.beta.similarity, 0.9, 'similarity = 组内 max(模型 noul)');
});

test('β：超预算 → 不调用、beta 为 null、stats.semantics.skipped 增加', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { maxPerMinute: 0 } },
    semantics: () => ({ beta_c1: noulAnswer(0.95) }),
  });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(semanticCalls().length, 0);
  assert.equal(decision.beta, null);
  assert.equal(decision.detail.semantics.reason, 'budget_exhausted');
  assert.equal(pipeline.stats().semantics.skipped, 1);
  assert.equal(pipeline.stats().semantics.calls, 0);
});

test('β：只有本地候选为零时才不调用；无关推文之间不发语义请求', async () => {
  const { pipeline, semanticCalls } = harness();
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide({ id: 'z1', handle: 'zz', text: '今天天气不错，我们一起去公园散步吧。', media: [], context: 'timeline' });
  assert.equal(semanticCalls().length, 0);
  assert.equal(decision.beta, null);
  assert.equal(decision.detail.semantics.candidates, 0);
});

test('β：foldInFeed=false 的 timeline 推文不发 β 问题（beta 为 null、不调用）', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { beta: { foldInFeed: false } } },
    semantics: () => ({ beta_c1: noulAnswer(0.95) }),
  });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(semanticCalls().length, 0);
  assert.equal(decision.beta, null);
  assert.equal(decision.detail.semantics.reason, 'beta_fold_disabled');
});

test('β：foldInReplies=false 的回复不发 β 问题，但 α 照常判定', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { beta: { foldInReplies: false } } },
    semantics: () => alphaAnswers({ extra: { beta_c1: noulAnswer(0.99) } }),
  });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const decision = await pipeline.decide(DIVERGENT_REPLY);
  const request = semanticCalls().at(-1);
  assert.ok(request, 'α 仍然要调用（不受折叠开关影响）');
  assert.ok(!Object.keys(request.questions).some((id) => id.startsWith('beta_c')), '不发 β 问题');
  assert.deepEqual(Object.keys(request.questions), [ALPHA_MAJORITY_ID, ALPHA_CONTRAST_ID]);
  assert.equal(decision.beta, null);
  assert.equal(decision.alpha.hit, true);
});

test('预算：语义调用计入全局 Jev 预算；全局只剩保底 50 时不调用', async () => {
  const patch = { budget: { ...DEFAULT_SETTINGS.budget, maxJevPerDay: 52 } };
  const { pipeline, semanticCalls } = harness({
    patch,
    filter: BLOCK_FILTER,
    semantics: () => ({ beta_c1: noulAnswer(0.95) }),
  });
  await pipeline.decide(SPAM_A); // 过滤调用 1（day.jev = 1），此时没有候选
  const decision = await pipeline.decide(SPAM_B); // 过滤调用 1（day.jev = 2）→ 语义检查时全局剩 50 = 保底
  assert.equal(semanticCalls().length, 0, '全局剩余 ≤ reserveForFiltering 时语义层必须停');
  assert.equal(decision.beta, null);
  assert.equal(decision.detail.semantics.reason, 'budget_exhausted');
  assert.equal(pipeline.stats().semantics.skipped, 1);
  assert.equal(pipeline.budget().jevDayRemaining, 50);
  assert.equal(pipeline.stats().jevCalls, 2, '被跳过的语义调用不占「模型调用」');
});

test('预算：全局剩 51 时语义照常调用，并占用全局 Jev 额度', async () => {
  const patch = { budget: { ...DEFAULT_SETTINGS.budget, maxJevPerDay: 53 } };
  const { pipeline, semanticCalls } = harness({
    patch,
    filter: BLOCK_FILTER,
    semantics: () => ({ beta_c1: noulAnswer(0.95) }),
  });
  await pipeline.decide(SPAM_A);
  const decision = await pipeline.decide(SPAM_B);
  assert.equal(semanticCalls().length, 1, '剩余 51 > 保底 50 → 允许');
  assert.equal(decision.beta.folded, true);
  assert.equal(pipeline.stats().semantics.calls, 1);
  assert.equal(pipeline.stats().semantics.skipped, 0);
  assert.equal(pipeline.budget().jevDayRemaining, 50, '过滤 2 次 + 语义 1 次 = 3');
  assert.equal(pipeline.stats().jevCalls, 3, 'jevCalls 与全局预算同口径：过滤 2 + 语义 1');
});

test('β：超预算不做「本地 verbatim 折叠」——一律 beta 为 null', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { maxPerDay: 0 } },
    semantics: () => ({ beta_c1: noulAnswer(0.99) }),
  });
  await pipeline.decide(COFFEE_A);
  const decision = await pipeline.decide(COFFEE_B);
  assert.equal(semanticCalls().length, 0);
  assert.equal(decision.beta, null, '完全相同的文本也交给农场机制处理，不留第二条零成本折叠路径');
});

/* =============================== α =============================== */

test('α：回复区 + 参考评论足够 + 明显不同 → 命中，score 与中文 summary 正确', async () => {
  const { pipeline, semanticCalls } = harness({
    semantics: () => alphaAnswers({ majority: 0.93, contrast: 3, extra: { beta_c1: noulAnswer(0.2), beta_c2: noulAnswer(0.2), beta_c3: noulAnswer(0.2) } }),
  });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const decision = await pipeline.decide(DIVERGENT_REPLY);
  assert.equal(semanticCalls().length, 1, '一轮只发一次调用');
  assert.deepEqual(decision.alpha, {
    hit: true,
    score: 1,
    reason: ALPHA_REASON,
    referenceCount: 3,
    summary: ALPHA_SUMMARY,
  });
  assert.match(decision.alpha.summary, /[\u4e00-\u9fa5]/, 'summary 是中文字符串');
  assert.equal(decision.beta, null);
  assert.equal(pipeline.stats().semantics.alphaHits, 1);
});

test('α：alpha_contrast 是 4 级分，归一化到 0..1（2.1 → 0.7）', async () => {
  const { pipeline } = harness({ semantics: () => alphaAnswers({ contrast: 2.1 }) });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const decision = await pipeline.decide(DIVERGENT_REPLY);
  assert.equal(decision.alpha.score, 0.7);
});

test('α：onlyInReplies 时时间线推文不判定（有参考上下文也不发调用）', async () => {
  const { pipeline, semanticCalls } = harness({ semantics: () => alphaAnswers() });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const target = { ...DIVERGENT_REPLY, id: 'r9', context: 'timeline' };
  const decision = await pipeline.decide(target);
  assert.equal(semanticCalls().length, 0, '参考与目标相似度 <0.30 不是 β 候选，α 又不适用于时间线 → 不调用');
  assert.equal(decision.alpha, null);
  assert.equal(decision.detail.semantics.references, 3, '参考上下文仍被汇总（只是没买 α 问题）');
});

test('α：onlyInReplies=false 时时间线也判定', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { alpha: { onlyInReplies: false } } },
    semantics: () => alphaAnswers(),
  });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const decision = await pipeline.decide({ ...DIVERGENT_REPLY, id: 'r8', context: 'timeline' });
  assert.ok(Object.keys(semanticCalls().at(-1).questions).includes(ALPHA_MAJORITY_ID));
  assert.equal(decision.alpha.hit, true);
});

test('α：参考评论少于 minReferences → 不问 α、alpha 为 null，也不发调用', async () => {
  const { pipeline, semanticCalls } = harness({ semantics: () => alphaAnswers() });
  await pipeline.decide(THREAD_REFS[0]);
  await pipeline.decide(THREAD_REFS[1]);
  const decision = await pipeline.decide(DIVERGENT_REPLY);
  assert.equal(semanticCalls().length, 0, '只有 2 条参考 < 3，且没有 β 候选 → 一次调用都不发');
  assert.equal(decision.detail.semantics.references, 2);
  assert.equal(decision.alpha, null);
});

test('α：与多数参考说法一致（本地相似度高）→ 不标 α（护栏）', async () => {
  const echoText = '这部电影结局铺垫充分，主角离开是唯一合理的选择。';
  const { pipeline } = harness({ semantics: () => alphaAnswers({ majority: 0.95 }) });
  for (const id of ['e1', 'e2', 'e3']) {
    await pipeline.decide({ id, handle: `h${id}`, text: echoText, media: [], context: 'reply', threadId: 'echo1' });
  }
  const decision = await pipeline.decide({ id: 'e4', handle: 'h4', text: echoText, media: [], context: 'reply', threadId: 'echo1' });
  assert.equal(decision.alpha, null, '跟着多数说的不该被标成特殊观点');
});

test('α：alpha_contrast / alpha_majority 缺字段 → alpha 为 null（不猜）', async () => {
  const onlyMajority = harness({ semantics: () => ({ [ALPHA_MAJORITY_ID]: noulAnswer(0.95) }) });
  for (const ref of THREAD_REFS) await onlyMajority.pipeline.decide(ref);
  assert.equal((await onlyMajority.pipeline.decide(DIVERGENT_REPLY)).alpha, null, '缺 score 不猜');

  const onlyContrast = harness({ semantics: () => ({ [ALPHA_CONTRAST_ID]: scoreAnswer(3) }) });
  for (const ref of THREAD_REFS) await onlyContrast.pipeline.decide(ref);
  assert.equal((await onlyContrast.pipeline.decide(DIVERGENT_REPLY)).alpha, null, '缺 noul 不猜');
});

test('α：alpha.enabled=false 时不问 α（无 β 候选时直接不调用）', async () => {
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { alpha: { enabled: false } } },
    semantics: () => alphaAnswers(),
  });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  const decision = await pipeline.decide(DIVERGENT_REPLY);
  assert.equal(semanticCalls().length, 0);
  assert.equal(decision.alpha, null);
});

test('α 命中优先于 β 折叠：beta 保留但 folded === false', async () => {
  // 同一楼里 3 条参考：两条与目标无关（只做 α 上下文），一条与目标本地相似（β 候选）。
  const threadId = 't5';
  const refs = [
    { id: 'p1', handle: 'u1', text: '我觉得这部电影的结局很合理，主角本来就应该离开。', media: [], context: 'reply', threadId },
    { id: 'p2', handle: 'u2', text: '同感，结局铺垫得很充分，离开是唯一合理的选择。', media: [], context: 'reply', threadId },
    { id: 'p3', handle: 'u3', text: '宠物医院说这只猫需要做手术，费用大概三千块。', media: [], context: 'reply', threadId },
  ];
  const target = { id: 'p4', handle: 'u4', text: '宠物医院说这只猫需要马上做手术，费用差不多三千块。', media: [], context: 'reply', threadId };
  assert.ok(semanticSimilarity(target.text, refs[2].text) >= CANDIDATE_MIN_SIMILARITY);

  const { pipeline, semanticCalls } = harness({
    semantics: () => ({
      beta_c1: noulAnswer(0.97),
      [ALPHA_MAJORITY_ID]: noulAnswer(0.93),
      [ALPHA_CONTRAST_ID]: scoreAnswer(3),
    }),
  });
  for (const ref of refs) await pipeline.decide(ref);
  const decision = await pipeline.decide(target);
  assert.deepEqual(Object.keys(semanticCalls().at(-1).questions), ['beta_c1', ALPHA_MAJORITY_ID, ALPHA_CONTRAST_ID]);
  assert.ok(decision.beta, 'β 组信息仍然保留，供 UI 展示');
  assert.equal(decision.beta.folded, false, 'α 命中时不得折叠');
  assert.equal(decision.beta.duplicateOf, 'p3');
  assert.equal(decision.beta.groupSize, 2);
  assert.equal(decision.alpha.hit, true);
});

/* ======================= 并发（真实浏览器形态，回归缺陷） ======================= */

/** 近似文案（本地 3-gram 0.565，≥0.45 是候选、<0.6 算 same_claim）。 */
const NEAR_A = {
  id: '1101',
  handle: 'near1',
  text: '今天下午去看了新上映的那部科幻片，特效很棒但剧情有点拖沓。',
  media: [],
  context: 'timeline',
};
const NEAR_B = {
  id: '1102',
  handle: 'near2',
  text: '今天下午看了新上映的科幻片，特效很棒，剧情稍微有点拖沓。',
  media: [],
  context: 'timeline',
};

test('并发（真站形态回归）：推文 id 为 null 时，并发判定仍必须送 β 候选并折叠第二条', async () => {
  // 端到端夹具/短 id 的真实形态：内容脚本的 getTweetId() 只认 `/status/<5..25 位数字>`，
  // 4 位 id（1101/1102）会被算成 null。窗口条目没有身份时 pickBetaCandidates 整条跳过 →
  // 真站上「0 次语义调用、β 全 null」而 α 照常命中（α 靠 threadId，不需要 id）。
  const betapairA = {
    id: null,
    handle: 'commuter_a',
    text: 'BETAPAIR：今天在地铁上看到有人给老人让座，感觉挺暖的',
    media: [],
    context: 'timeline',
  };
  const betapairB = {
    id: null,
    handle: 'commuter_b',
    text: 'BETAPAIR：今天坐地铁，有人主动给老人让座，感觉挺暖的',
    media: [],
    context: 'timeline',
  };
  assert.ok(semanticSimilarity(betapairA.text, betapairB.text) >= CANDIDATE_MIN_SIMILARITY);

  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.88) }) });
  const [first, second] = await Promise.all([pipeline.decide(betapairA), pipeline.decide(betapairB)]);
  assert.equal(semanticCalls().length, 1, '必须有一次带候选组的语义调用（真站缺陷：0 次）');
  assert.deepEqual(Object.keys(semanticCalls()[0].questions), ['beta_c1']);
  assert.equal(first.beta, null, '先出现的推文不折叠到后出现的条上');
  assert.equal(second.beta.folded, true);
  assert.equal(second.beta.groupSize, 2);
  assert.equal(
    second.beta.duplicateOf,
    `h:${hash32(`commuter_a|${betapairA.text}`)}`,
    '缺 id 时 duplicateOf 用「作者 + 文案」的稳定身份（真实 id 优先）',
  );
  assert.ok(['verbatim', 'paraphrase', 'same_claim'].includes(second.beta.kind), `kind=${second.beta.kind}`);
  assert.equal(pipeline.stats().semantics.candidateSets, 1);
  assert.equal(pipeline.stats().semantics.betaFolds, 1);
});

test('并发（真站形态 + 确定性延迟）：id 为 null 且第一条往返更慢时，第二条仍必须折叠', async () => {
  const slowFirst = {
    id: null,
    handle: 'slowfirst',
    text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利',
    media: [],
    context: 'timeline',
  };
  const fastSecond = {
    id: null,
    handle: 'fastsecond',
    text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利 支持视频验证',
    media: [],
    context: 'timeline',
  };
  const { pipeline, semanticCalls } = harness({
    filter: BLOCK_FILTER,
    filterDelay: (request) => (request.state.includes('@slowfirst') ? 30 : 0),
    semantics: () => ({ beta_c1: noulAnswer(0.9) }),
  });
  const [first, second] = await Promise.all([pipeline.decide(slowFirst), pipeline.decide(fastSecond)]);
  assert.equal(semanticCalls().length, 1);
  assert.equal(first.beta, null);
  assert.equal(second.detail.semantics.candidates, 1);
  assert.equal(second.beta.folded, true);
  assert.equal(second.beta.duplicateOf, `h:${hash32(`slowfirst|${slowFirst.text}`)}`);
});

test('窗口身份：没有推文 id 时用「作者 + 文案」稳定哈希，同一条重入窗口只保留一份', () => {
  const window = createRecentWindow({ maxSize: 10, now: () => 1000 });
  const a = window.push({ id: null, handle: '@ann', text: '同一段文案' });
  assert.match(a.id, /^h:[0-9a-f]{8}$/, '缺 id 时生成稳定哈希身份');
  const b = window.push({ id: null, handle: 'ann', text: '同一段文案' });
  assert.equal(b.id, a.id, '同作者 + 同文案 → 同一身份（@ 前缀无关）');
  assert.equal(window.size(), 1, '重入窗口是刷新而不是新增');
  const c = window.push({ id: null, handle: 'bob', text: '同一段文案' });
  assert.notEqual(c.id, a.id, '不同作者 → 不同身份');
  assert.equal(window.size(), 2);
  const d = window.push({ id: '1912345678901234567', handle: 'ann', text: '同一段文案' });
  assert.equal(d.id, '1912345678901234567', '真实推文 id 优先');
});

test('并发（确定性回归）：先发的那条模型往返更慢时，后一条仍必须看到它并折叠', async () => {
  // 复刻真实 Chrome 的交错：同一屏两条近似文案并发判定，**第一条的网络往返更慢**。
  // 只有当推文在判定开始时就进窗口（先观察后判定），后一条才看得到前一条。
  const slowFirst = {
    id: 'slow1',
    handle: 'slowfirst',
    text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利',
    media: [],
    context: 'timeline',
  };
  const fastSecond = {
    id: 'fast2',
    handle: 'fastsecond',
    text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利 支持视频验证',
    media: [],
    context: 'timeline',
  };
  assert.ok(semanticSimilarity(slowFirst.text, fastSecond.text) >= CANDIDATE_MIN_SIMILARITY);

  const { pipeline, semanticCalls } = harness({
    filter: BLOCK_FILTER,
    // 第一条的过滤调用慢 30ms；第二条立即返回 → 第二条会先进入语义规划
    filterDelay: (request) => (request.state.includes('@slowfirst') ? 30 : 0),
    semantics: () => ({ beta_c1: noulAnswer(0.9) }),
  });
  const [first, second] = await Promise.all([pipeline.decide(slowFirst), pipeline.decide(fastSecond)]);
  assert.equal(semanticCalls().length, 1, '慢的那条不该反向折叠（selfSeq 边界）');
  assert.equal(first.beta, null);
  assert.equal(second.detail.semantics.candidates, 1, '快的那条必须看到慢的那条');
  assert.equal(second.beta.folded, true);
  assert.equal(second.beta.duplicateOf, 'slow1');
});

test('并发：同屏两条近似文案，后一条必须看到前一条并折叠（真实 Chrome 缺陷回归）', async () => {
  const local = semanticSimilarity(NEAR_A.text, NEAR_B.text);
  assert.ok(local >= CANDIDATE_MIN_SIMILARITY && local < 1, `夹具相似度应在 [0.45, 1)，实际 ${local}`);

  const { pipeline, semanticCalls } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.9) }) });
  // 故意**不**顺序 await：内容脚本对同屏多篇文章是并发发消息的（SW 在 await 处交错）。
  const [first, second] = await Promise.all([pipeline.decide(NEAR_A), pipeline.decide(NEAR_B)]);
  assert.equal(semanticCalls().length, 1, '只有后出现的那条发语义调用（前一条没有更早的候选）');
  assert.deepEqual(Object.keys(semanticCalls()[0].questions), ['beta_c1']);
  assert.equal(first.beta, null, '先出现的推文不能反过来折叠到后出现的条上');
  assert.equal(first.detail.semantics.reason, 'no_candidates');
  assert.equal(second.detail.semantics.candidates, 1);
  assert.equal(second.beta.folded, true);
  assert.equal(second.beta.duplicateOf, '1101');
  assert.equal(second.beta.groupSize, 2);

  // 对照：顺序 await 也必须得到同样的结论（回归保护）
  const sequential = harness({ semantics: () => ({ beta_c1: noulAnswer(0.9) }) });
  await sequential.pipeline.decide(NEAR_A);
  const seqSecond = await sequential.pipeline.decide(NEAR_B);
  assert.equal(seqSecond.beta.folded, true);
  assert.equal(seqSecond.beta.duplicateOf, '1101');
});

test('并发：同 threadId 的两条回复，后判定的一条能看到前一条作为参考', async () => {
  const replyA = {
    id: 'c1',
    handle: 'replyA',
    text: '我觉得这部电影的结局很合理，主角本来就应该离开。',
    media: [],
    context: 'reply',
    threadId: 'tc',
  };
  const replyB = {
    id: 'c2',
    handle: 'replyB',
    text: '完全不同意，这个结局是失败的，主角留下来才合理。',
    media: [],
    context: 'reply',
    threadId: 'tc',
  };
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { alpha: { minReferences: 1 } } },
    semantics: () => alphaAnswers(),
  });
  const [, second] = await Promise.all([pipeline.decide(replyA), pipeline.decide(replyB)]);
  assert.equal(second.detail.semantics.references, 1, '后判定的一条必须看到前一条');
  const withEarlier = semanticCalls().find((request) => request.state.includes('@replyA:'));
  assert.ok(withEarlier, '前一条的文本必须出现在后一条的 REFERENCES 里');
  assert.equal(second.alpha.hit, true);
});

test('α 护栏：已判定为非 ignore 的同楼条目不作为参考', async () => {
  const filter = (request) => (request.state.includes('同城约啪') ? BLOCK_FILTER : ORDINARY_FILTER);
  const { pipeline, semanticCalls } = harness({
    patch: { semantics: { alpha: { minReferences: 1 } } },
    filter,
    semantics: () => alphaAnswers(),
  });
  const blocked = await pipeline.decide({
    id: 'bad1',
    handle: 'spammer',
    text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利',
    media: [],
    context: 'reply',
    threadId: 'tg',
  });
  assert.equal(blocked.band, 'block', '第一条要真的被判成非 ignore');
  const target = await pipeline.decide({
    id: 'g2',
    handle: 'user',
    text: '我觉得这部电影的结局很合理，主角本来就应该离开。',
    media: [],
    context: 'reply',
    threadId: 'tg',
  });
  assert.equal(target.detail.semantics.references, 0, '被 block 的评论不算「评论区多数观点」');
  assert.equal(semanticCalls().length, 0, '没有候选也没有参考 → 不调用');
  assert.equal(target.alpha, null);
});

/* =============================== 不变量 I1（对照） =============================== */

/** 同一串推文分别在「语义关闭」与「语义开启」两条流水线上跑，用于对照。 */
async function pairedControl({ patch = {}, semantics = () => ({}), failSemantics = false, tweets }) {
  const off = harness({ patch: { ...patch, semantics: { enabled: false } }, filter: BLOCK_FILTER });
  const on = harness({ patch, filter: BLOCK_FILTER, semantics, failSemantics });
  const offDecisions = [];
  const onDecisions = [];
  for (const tweet of tweets) {
    offDecisions.push(await off.pipeline.decide(tweet));
    onDecisions.push(await on.pipeline.decide(tweet));
  }
  return { off, on, offDecisions, onDecisions };
}

function assertSameFiltering(a, b, message) {
  assert.equal(b.band, a.band, `${message}：band 必须一致`);
  assert.equal(b.source, a.source, `${message}：source 必须一致`);
  assert.deepEqual(b.reasons, a.reasons, `${message}：reasons 必须一致`);
  assert.deepEqual(b.accountAction, a.accountAction, `${message}：accountAction 必须一致`);
  assert.deepEqual(b.prefilter, a.prefilter, `${message}：prefilter 必须一致`);
}

test('不变量：β 折叠不改变 band / accountAction（成对对照）', async () => {
  const { onDecisions, offDecisions } = await pairedControl({
    semantics: () => ({ beta_c1: noulAnswer(0.96) }),
    tweets: [SPAM_A, SPAM_B],
  });
  const control = offDecisions.at(-1);
  const withBeta = onDecisions.at(-1);
  assert.equal(control.band, 'block', '对照组本身要走到 block，否则这条测试没意义');
  assert.equal(control.beta, null);
  assert.equal(control.alpha, null);
  assert.equal(withBeta.beta.folded, true, 'β 确实折叠了');
  assertSameFiltering(control, withBeta, 'β 折叠');
});

test('不变量：α 命中不改变 band / accountAction（成对对照）', async () => {
  const { onDecisions, offDecisions } = await pairedControl({
    semantics: () => alphaAnswers(),
    tweets: [...THREAD_REFS, DIVERGENT_REPLY],
  });
  const control = offDecisions.at(-1);
  const withAlpha = onDecisions.at(-1);
  assert.equal(withAlpha.alpha.hit, true, '对照组要真的命中 α，否则这条测试没意义');
  assertSameFiltering(control, withAlpha, 'α 标记');
});

test('不变量：语义模型抛错时过滤结果不变、errors 增加、不抛异常', async () => {
  const { on, onDecisions, offDecisions } = await pairedControl({
    semantics: () => ({}),
    failSemantics: true,
    tweets: [SPAM_A, SPAM_B],
  });
  const control = offDecisions.at(-1);
  const failed = onDecisions.at(-1);
  assert.equal(failed.beta, null);
  assert.equal(failed.alpha, null);
  assert.equal(failed.detail.semantics.reason, 'model_error:semantics 网关 503');
  assert.equal(on.pipeline.stats().semantics.errors, 1);
  assert.equal(on.pipeline.stats().jevCalls, 3, '失败的那次也算调用（与过滤路径同一口径）');
  assertSameFiltering(control, failed, '语义失败');
});

test('不变量：语义载荷为 null 时不出现折叠/标记副作用（beta/alpha 显式 null）', async () => {
  const { pipeline } = harness({ patch: { semantics: { enabled: false } }, filter: BLOCK_FILTER });
  const decision = await pipeline.decide(SPAM_A);
  assert.equal(decision.beta, null);
  assert.equal(decision.alpha, null);
  assert.equal(typeof decision.band, 'string');
});

/* =============================== 统计与冻结接口 =============================== */

test('stats.semantics：字段齐全、计数正确、返回的是拷贝', async () => {
  const { pipeline } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.9) }) });
  await pipeline.decide(COFFEE_A);
  await pipeline.decide(COFFEE_B);
  const stats = pipeline.stats();
  assert.deepEqual(Object.keys(stats.semantics).sort(), ['alphaHits', 'betaFolds', 'calls', 'candidateSets', 'errors', 'skipped']);
  assert.deepEqual(stats.semantics, { calls: 1, betaFolds: 1, alphaHits: 0, skipped: 0, errors: 0, candidateSets: 1 });
  assert.equal(stats.jevCalls, 1, '语义调用也计入「模型调用」总数（弹窗口径）');
  stats.semantics.calls = 999;
  assert.equal(pipeline.stats().semantics.calls, 1, 'stats() 必须返回拷贝，不能被外部改坏');
  assert.equal(pipeline.stats().jevCalls, 1);
});

test('冻结接口：beta / alpha 的字段名与取值类型逐字一致', async () => {
  const { pipeline } = harness({ semantics: () => ({ beta_c1: noulAnswer(0.86) }) });
  await pipeline.decide(COFFEE_A);
  const betaDecision = await pipeline.decide(COFFEE_B);
  assert.deepEqual(Object.keys(betaDecision.beta), ['duplicateOf', 'groupKey', 'groupSize', 'similarity', 'kind', 'folded']);
  assert.equal(typeof betaDecision.beta.duplicateOf, 'string');
  assert.match(betaDecision.beta.groupKey, /^bk_[0-9a-f]{8}$/);
  assert.equal(typeof betaDecision.beta.groupSize, 'number');
  assert.equal(typeof betaDecision.beta.similarity, 'number');
  assert.ok([SEMANTICS_KIND.verbatim, SEMANTICS_KIND.paraphrase, SEMANTICS_KIND.same_claim].includes(betaDecision.beta.kind));
  assert.equal(typeof betaDecision.beta.folded, 'boolean');

  const alphaRun = harness({ semantics: () => alphaAnswers() });
  for (const ref of THREAD_REFS) await alphaRun.pipeline.decide(ref);
  const alphaDecision = await alphaRun.pipeline.decide(DIVERGENT_REPLY);
  assert.deepEqual(Object.keys(alphaDecision.alpha), ['hit', 'score', 'reason', 'referenceCount', 'summary']);
  assert.equal(alphaDecision.alpha.hit, true);
  assert.equal(alphaDecision.alpha.reason, 'diverges_from_majority');
  assert.equal(typeof alphaDecision.alpha.score, 'number');
  assert.ok(alphaDecision.alpha.score >= 0 && alphaDecision.alpha.score <= 1);
  assert.equal(typeof alphaDecision.alpha.referenceCount, 'number');
  assert.equal(alphaDecision.alpha.summary, '与评论区多数观点不同');
});

test('冻结接口：过滤关闭 / 预筛跳过时 beta 与 alpha 也是显式 null', async () => {
  const off = harness({ patch: { enabled: false } });
  const disabled = await off.pipeline.decide(SPAM_A);
  assert.equal(disabled.beta, null);
  assert.equal(disabled.alpha, null);
  assert.equal(disabled.detail.semantics.reason, 'semantics_disabled');

  const skipped = harness({ patch: { whitelist: { handles: ['spammer'], keywords: [] } } });
  const whitelisted = await skipped.pipeline.decide(SPAM_A);
  assert.equal(whitelisted.skip, 'whitelisted_handle');
  assert.equal(whitelisted.beta, null);
  assert.equal(whitelisted.alpha, null);
  assert.equal(whitelisted.detail.semantics.reason, 'prefilter_skipped');
});

test('冻结接口：tweet.threadId 用于 α 参考与 β 同线程候选', async () => {
  const { pipeline, semanticCalls } = harness({ semantics: () => alphaAnswers() });
  for (const ref of THREAD_REFS) await pipeline.decide(ref);
  await pipeline.decide(DIVERGENT_REPLY);
  const state = semanticCalls().at(-1).state;
  assert.ok(state.includes('thread_id=t1'));
  assert.ok(state.includes('[1] @ann:'), '参考评论按 threadId 汇集进 REFERENCES');
});

test('计划层：0 候选且 α 不适用 → 不发调用；reason 说明原因', () => {
  const settings = normalizeSettings({});
  const plan = planSemanticCall({ target: COFFEE_A, recent: [], settings });
  assert.equal(plan.call, false);
  assert.equal(plan.reason, 'no_candidates');
  assert.deepEqual(plan.questions, {});

  const off = normalizeSettings({ semantics: { enabled: false } });
  assert.equal(planSemanticCall({ target: COFFEE_B, recent: [], settings: off }).reason, 'semantics_disabled');
});

test('答案解析：候选/参考不在计划里时 beta/alpha 一律 null（不猜）', () => {
  const settings = normalizeSettings({});
  const emptyPlan = {
    betaAllowed: true,
    alphaApplicable: false,
    candidateCount: 0,
    candidates: [],
    references: [],
  };
  const { beta, alpha } = readSemanticsAnswers({ beta_c1: noulAnswer(0.99), alpha_majority: noulAnswer(0.99) }, {
    plan: emptyPlan,
    target: COFFEE_A,
    settings,
  });
  assert.equal(beta, null);
  assert.equal(alpha, null);
});
