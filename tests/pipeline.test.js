/**
 * 流水线集成测试：用假 Jev 客户端 + 假图片分析跑完整判定，
 * 覆盖成本控制、缓存、预算、降级与「不变量 I1」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../src/sw/pipeline.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';
import { createAuditor } from '../src/sw/audit.js';

const noulAnswer = (noul) => ({ type: 'noul', noul });
const choiceAnswer = (choice, confidence, probabilities = {}) => ({ type: 'choice', choice, confidence, probabilities });
const scoreAnswer = (score, confidence = 0.8) => ({ type: 'score', score, confidence, legend: {}, probabilities: {} });

function answersFor({ adult = 0.1, sol = 0.1, dec = 0, cat = 'ordinary', conf = 0.4, sev = 2.5 } = {}) {
  return {
    adult: noulAnswer(adult),
    solicitation: noulAnswer(sol),
    deceptive: noulAnswer(dec),
    category: choiceAnswer(cat, conf),
    severity: scoreAnswer(sev),
  };
}

const SPAM_TWEET = {
  id: '111',
  handle: 'spammer',
  text: '同城约啪 加电报 t.me/abc 少妇上门 视频福利',
  media: [],
  context: 'timeline',
};

const ORDINARY_TWEET = {
  id: '222',
  handle: 'normal',
  text: '今天天气不错，我们一起去公园散步吧，顺便看看新开的书店。',
  media: [],
  context: 'timeline',
};

/**
 * 按请求里问了几问来分派答案：
 * 只问 1 问（bait）= 预检；问 4 问 = 完整判定。真实网关就是这么被调用的。
 */
function scriptedAnswers({ junk = 0.05, full = null } = {}) {
  return (request) => {
    const ids = Object.keys(request?.questions ?? {});
    if (ids.length === 1 && ids[0] === 'junk') return { junk: noulAnswer(junk) };
    return full ?? answersFor();
  };
}

function harness({ settingsPatch = {}, answers = answersFor(), fail, analyzeImage, vision, random, now = () => 1_700_000_000_000 } = {}) {
  let settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settingsPatch });
  const calls = [];
  const actions = [];
  const jev = {
    calls,
    async systemOne(request) {
      calls.push(request);
      if (fail) throw new Error(fail);
      const payload = typeof answers === 'function' ? answers(request) : answers;
      return { model: 'jev-test', answers: payload, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
  const auditor = createAuditor({ version: 'test' });
  const pipeline = createPipeline({
    getSettings: () => settings,
    jev,
    analyzeImage,
    classifyWithVision: vision,
    auditor,
    now,
    random,
    onActionCandidate: (decision) => actions.push(decision),
  });
  return { pipeline, jev, auditor, actions, setSettings: (patch) => (settings = normalizeSettings({ ...settings, ...patch })) };
}

test('色情引流推文：block 档 + 演练模式下不执行动作，但仍进黑名单候选', async () => {
  const { pipeline, jev, actions } = harness({
    answers: answersFor({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.93, sev: 3.1 }),
  });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'block');
  assert.equal(decision.source, 'jev');
  assert.equal(decision.accountAction.kind, 'mute');
  assert.equal(decision.accountAction.execute, false);
  assert.equal(decision.accountAction.reason, 'dry_run');
  assert.equal(jev.calls.length, 1);
  assert.equal(actions.length, 1, 'block 档要能被后台记入黑名单');
});

test('普通推文：默认只花一次廉价预检单问（不是五问），随后放行', async () => {
  const { pipeline, jev } = harness({ answers: scriptedAnswers({ junk: 0.05 }) });
  const decision = await pipeline.decide(ORDINARY_TWEET);
  assert.equal(decision.band, 'ignore');
  assert.equal(jev.calls.length, 1, '预检 = 一次单问');
  assert.deepEqual(Object.keys(jev.calls[0].questions), ['junk'], '预检只问 junk 一问');
  assert.equal(pipeline.stats().triageProbes, 1);
});

test('关掉预检 → 回到「只有候选才花钱」的 0 请求模式', async () => {
  const off = normalizeSettings({ ...DEFAULT_SETTINGS, triage: { ...DEFAULT_SETTINGS.triage, enabled: false } });
  const { pipeline, jev } = harness();
  pipeline.clearCache();
  const { pipeline: p2, jev: j2 } = harness({ settingsPatch: { triage: off.triage } });
  const decision = await p2.decide(ORDINARY_TWEET);
  assert.equal(decision.band, 'ignore');
  assert.equal(decision.source, 'local');
  assert.equal(j2.calls.length, 0);
  assert.equal(pipeline.stats().triageProbes, 0);
});

test('预检未命中（低分）→ 放行，且不跑完整四问', async () => {
  const { pipeline, jev } = harness({ answers: scriptedAnswers({ junk: 0.12 }) });
  const decision = await pipeline.decide(ORDINARY_TWEET);
  assert.equal(decision.band, 'ignore');
  assert.equal(jev.calls.length, 1);
  assert.equal(decision.detail.triage.probed, true);
  assert.equal(decision.detail.triage.escalated, false);
});

test('预检命中（≥0.65 但 < 0.75）→ 隐藏成待确认，绝不动作（真站「骚式自夸」样本）', async () => {
  const BaitTweet = {
    id: 'bait1',
    handle: 'yrmyzhcxvlkzpu',
    displayName: 'yrmyzh cxvlu',
    text: '比我好看的没我骚🔧👏比我骚的没我好看',
    media: [],
    context: 'timeline',
  };
  const { pipeline, jev, actions } = harness({ answers: scriptedAnswers({ junk: 0.7 }) });
  const decision = await pipeline.decide(BaitTweet);
  assert.equal(decision.band, 'review');
  assert.ok(decision.reasons.includes('junk_probe'));
  assert.equal(decision.source, 'triage');
  assert.equal(decision.accountAction.kind, 'none');
  assert.equal(actions.length, 0, '预检永远不产生账号动作');
  assert.equal(jev.calls.length, 1, '0.7 < 0.75 升级线，所以只花一次单问');
});

test('预检很确信（≥0.75）→ 升级为完整四问，仍受强类别闸门约束', async () => {
  // 注意：正文里不能出现任何本地强特征，否则它就直接走四问了（那是对照组的另一条路径）
  const BaitTweet = { id: 'bait2', handle: 'yrmyzhcxvlkzpu', displayName: 'yrmyzh cxvlu', text: '比我好看的没我骚🔧👏比我骚的没我好看', media: [], context: 'timeline' };
  const { pipeline, jev } = harness({
    answers: scriptedAnswers({ junk: 0.93, full: answersFor({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.94 }) }),
  });
  const decision = await pipeline.decide(BaitTweet);
  assert.equal(jev.calls.length, 2, '预检 + 升级后的五问');
  assert.ok(decision.detail.triage.escalated);
  assert.equal(decision.band, 'block');
  assert.equal(decision.source, 'jev');
});

test('预检预算/采样率受限时不发起调用', async () => {
  const noBudget = harness({ answers: scriptedAnswers({ junk: 0.9 }), settingsPatch: { triage: { enabled: true, sampleRate: 1, maxPerMinute: 20, maxPerDay: 0 } } });
  const r1 = await noBudget.pipeline.decide(ORDINARY_TWEET);
  assert.equal(r1.band, 'ignore');
  assert.equal(noBudget.jev.calls.length, 0);
  assert.equal(r1.detail.triage.skipped, 'triage_budget_exhausted');

  const noSample = harness({ answers: scriptedAnswers({ junk: 0.9 }), settingsPatch: { triage: { enabled: true, sampleRate: 0, maxPerMinute: 20, maxPerDay: 600 } } });
  const r2 = await noSample.pipeline.decide(ORDINARY_TWEET);
  assert.equal(r2.band, 'ignore');
  assert.equal(noSample.jev.calls.length, 0);
  assert.equal(r2.detail.triage.skipped, 'not_sampled');
});

test('随机账号名（乱码 handle）会提高本地点数，但单独不足以隐藏', async () => {
  const randomHandle = { id: 'r1', handle: 'yrmyzhcxvlkzpu', displayName: 'yrmyzh cxvlu', text: '晚上好呀朋友们', media: [], context: 'timeline' };
  const { pipeline } = harness({ answers: scriptedAnswers({ junk: 0.05 }) });
  const decision = await pipeline.decide(randomHandle);
  assert.equal(decision.band, 'ignore');
  assert.equal(decision.prefilter.randomName, true);
});

test('白名单账号：连预筛都跳过', async () => {
  const { pipeline, jev } = harness({ settingsPatch: { whitelist: { handles: ['spammer'], keywords: [] } } });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'ignore');
  assert.equal(decision.skip, 'whitelisted_handle');
  assert.equal(jev.calls.length, 0);
});

test('相同推文第二次命中缓存，不再调用模型', async () => {
  const { pipeline, jev } = harness({ answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }) });
  const first = await pipeline.decide(SPAM_TWEET);
  const second = await pipeline.decide(SPAM_TWEET);
  assert.equal(first.source, 'jev');
  assert.equal(second.source, 'cache');
  assert.equal(second.cached, true);
  assert.equal(jev.calls.length, 1);
  assert.equal(pipeline.stats().cacheHits, 1);
});

test('阈值变化会让缓存失效（不会拿旧阈值的结论复用）', async () => {
  const { pipeline, jev, setSettings } = harness({ answers: answersFor({ adult: 0.8, cat: 'adult_porn', conf: 0.6 }) });
  const first = await pipeline.decide(SPAM_TWEET);
  setSettings({ thresholds: { ...DEFAULT_SETTINGS.thresholds, blockNoul: 0.7, blockConfidence: 0.5 } });
  const second = await pipeline.decide(SPAM_TWEET);
  assert.equal(first.band, 'hide');
  assert.equal(second.band, 'block', '阈值放宽后应重新判定');
  assert.equal(jev.calls.length, 2);
});

test('模型预算耗尽：不发起调用，降级为待确认', async () => {
  const { pipeline, jev } = harness({ settingsPatch: { budget: { ...DEFAULT_SETTINGS.budget, maxJevPerMinute: 0 } } });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'review');
  assert.ok(decision.reasons.includes('budget_exhausted'));
  assert.equal(jev.calls.length, 0);
});

test('模型报错：有本地强信号 → 待确认；不误伤、不静默放行', async () => {
  const { pipeline } = harness({ fail: 'upstream 500' });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'review');
  assert.ok(decision.reasons.includes('model_error'));
  assert.equal(decision.source, 'local');
});

test('模型返回残缺答案：标记 schema_invalid 并降级', async () => {
  const { pipeline } = harness({ answers: { adult: noulAnswer(0.99) } });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'review');
  assert.ok(decision.reasons.includes('schema_invalid'));
  assert.equal(pipeline.stats().schemaInvalid, 1);
});

test('图片信号可以佐证隐藏，但单独存在时绝不触发账号动作', async () => {
  const analyzeImage = async () => ({
    ok: true,
    stats: { pixels: 4096, skinRatio: 0.8, maxCellRatio: 0.9, dominantCells: 16, cells: 16, flatRatio: 0.2, texture: 0.1 },
  });
  const mediaTweet = { id: '333', handle: 'pic-only', text: '看这个', media: ['https://pbs.twimg.com/media/a.jpg?name=small'], context: 'timeline' };

  // 模型否认 + 短文案 + 图片裸露：「只发图」形态 → 隐藏成待确认（仍不动作，也不进入 block 档）
  const denied = harness({ answers: answersFor({ adult: 0.15, cat: 'ordinary', conf: 0.8 }), analyzeImage });
  const deniedDecision = await denied.pipeline.decide(mediaTweet);
  assert.equal(deniedDecision.band, 'review');
  assert.equal(deniedDecision.accountAction.kind, 'none');

  // 模型否认 + 文案信息量足够（不是纯图形态）→ 放行：图片信号单独不足以隐藏
  const longText = harness({ answers: answersFor({ adult: 0.15, cat: 'ordinary', conf: 0.8 }), analyzeImage });
  const longTextDecision = await longText.pipeline.decide({
    ...mediaTweet,
    text: '今天去海边拍了些照片，风很大但是风景不错，推荐大家来玩，附上沙滩和日落。',
  });
  assert.equal(longTextDecision.band, 'ignore');
  assert.equal(longTextDecision.accountAction.kind, 'none');

  // 模型说“疑似”（0.6）+ 图片肤色占比很高 → 隐藏，但绝不进入 block 档
  const suspicious = harness({ answers: answersFor({ adult: 0.6, cat: 'suggestive', conf: 0.5 }), analyzeImage });
  const suspiciousDecision = await suspicious.pipeline.decide(mediaTweet);
  assert.equal(suspiciousDecision.band, 'hide');
  assert.equal(suspiciousDecision.accountAction.kind, 'none');
  assert.equal(suspiciousDecision.detail.mediaSkinRatio, 0.8);

  // 同样的模型回答，但没有图片佐证 → 只到待确认
  const noMedia = harness({ answers: answersFor({ adult: 0.6, cat: 'suggestive', conf: 0.5 }) });
  const reviewDecision = await noMedia.pipeline.decide({ ...mediaTweet, media: [], text: '同城约啪 加电报 t.me/abc' });
  assert.equal(reviewDecision.band, 'review');
  assert.equal(reviewDecision.accountAction.kind, 'none');
});

test('图片下载失败不影响判定（只是少了佐证）', async () => {
  const { pipeline, jev } = harness({
    answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }),
    analyzeImage: async () => ({ ok: false, error: 'http_404' }),
  });
  const decision = await pipeline.decide({ ...SPAM_TWEET, media: ['https://pbs.twimg.com/media/x.jpg'] });
  assert.equal(decision.band, 'block');
  assert.equal(jev.calls.length, 1);
});

test('纯图片黄推：模型说不是色情，但「只发图形态 + 图片裸露」仍隐藏成待确认（不动作）', async () => {
  const analyzeImage = async () => ({
    ok: true,
    stats: { pixels: 4096, skinRatio: 0.8, maxCellRatio: 0.9, dominantCells: 16, cells: 16, flatRatio: 0.2, texture: 0.1 },
  });
  const { pipeline, jev } = harness({ answers: answersFor({ adult: 0.21, cat: 'ordinary', conf: 0.61 }), analyzeImage });
  const decision = await pipeline.decide({
    id: '333',
    handle: 'pic-only',
    text: '看',
    media: ['https://pbs.twimg.com/media/a.jpg?name=small'],
    context: 'timeline',
  });
  assert.equal(decision.band, 'review');
  assert.equal(decision.accountAction.kind, 'none');
  assert.equal(jev.calls.length, 1, '仍然问过模型，不是纯本地结论');
});

test('双确认：两条独立 Noul + 极高类别置信度 → block（真实模型对商业推广的典型输出）', async () => {
  const { pipeline } = harness({
    answers: answersFor({ adult: 0.85, sol: 0.86, cat: 'adult_solicitation', conf: 0.96 }),
  });
  const decision = await pipeline.decide({
    id: '444',
    handle: 'creator',
    text: 'My OnlyFans is 50% off today, link in bio',
    media: [],
    context: 'timeline',
  });
  assert.equal(decision.band, 'block');
  assert.ok(decision.reasons.includes('dual_confirmation_block'));
  assert.equal(decision.accountAction.kind, 'mute');
  assert.equal(decision.accountAction.execute, false, '默认演练模式');
});

test('关闭过滤时一切放行且不打模型', async () => {
  const { pipeline, jev } = harness({ settingsPatch: { enabled: false } });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'ignore');
  assert.equal(decision.skip, 'disabled');
  assert.equal(jev.calls.length, 0);
});

test('关闭隐藏时仍会判定，但不产生隐藏动作', async () => {
  const { pipeline } = harness({
    settingsPatch: { action: { ...DEFAULT_SETTINGS.action, hide: false } },
    answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }),
  });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.band, 'block');
  assert.equal(decision.hideByScope, true, '是否隐藏由内容脚本结合 action.hide 决定');
});

test('关闭自动动作时不规划任何账号操作', async () => {
  const { pipeline } = harness({
    settingsPatch: { action: { ...DEFAULT_SETTINGS.action, autoMute: false, autoBlock: false, dryRun: false } },
    answers: answersFor({ adult: 0.99, cat: 'adult_porn', conf: 0.95 }),
  });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.equal(decision.accountAction.kind, 'none');
  assert.equal(decision.accountAction.reason, 'no_action_configured');
});

test('并发重复请求只判定一次', async () => {
  const { pipeline, jev } = harness({ answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }) });
  const [a, b] = await Promise.all([pipeline.decide(SPAM_TWEET), pipeline.decide(SPAM_TWEET)]);
  assert.equal(a.band, b.band);
  assert.equal(jev.calls.length, 1);
});

test('每条判定都会写入审计缓冲（含原因）', async () => {
  const { pipeline, auditor } = harness({ answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }) });
  await pipeline.decide(SPAM_TWEET);
  await pipeline.decide(ORDINARY_TWEET);
  const events = auditor.list();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'decision');
  assert.equal(events[0].tweet.handle, 'spammer');
  assert.ok(events[0].decision.reasons.length > 0);
  assert.equal(events[0].source, 'jev-x-filter');
});

test('reasons 都带中文标签，便于 UI 直接展示', async () => {
  const { pipeline } = harness({ answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }) });
  const decision = await pipeline.decide(SPAM_TWEET);
  assert.ok(decision.reasonLabels.length > 0);
  assert.ok(decision.reasonLabels.every((label) => /[\u4e00-\u9fa5]/.test(label)));
});

test('统计数据反映成本（调用数 / 零请求跳过 / 各档位计数 / 预检计数）', async () => {
  // 关掉预检：普通推文 0 请求
  const noTriage = harness({
    answers: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }),
    settingsPatch: { triage: { enabled: false } },
  });
  await noTriage.pipeline.decide(SPAM_TWEET);
  await noTriage.pipeline.decide(ORDINARY_TWEET);
  const stats = noTriage.pipeline.stats();
  assert.equal(stats.jevCalls, 1, '只有候选花钱');
  assert.equal(stats.bands.block, 1);
  assert.equal(stats.bands.ignore, 1);
  assert.equal(stats.decisions, 2);
  assert.equal(stats.triageProbes, 0);

  // 打开预检：普通推文多一次廉价单问
  const withTriage = harness({ answers: scriptedAnswers({ junk: 0.05, full: answersFor({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }) }) });
  await withTriage.pipeline.decide(SPAM_TWEET);
  await withTriage.pipeline.decide(ORDINARY_TWEET);
  const stats2 = withTriage.pipeline.stats();
  assert.equal(stats2.jevCalls, 2);
  assert.equal(stats2.triageProbes, 1);
  assert.equal(stats2.triageHits, 0);
});

test('真站漏检样本回归：正文无害、引流在显示名 → 至少隐藏；模型确认时升级为 block', async () => {
  const sample = {
    id: 'je1',
    handle: 'JesseAlvarl3',
    displayName: '🍑真实同城约p🍑主页联系🔞免费',
    text: '那一夜你没有拒绝我😭🤣不是人机',
    media: [],
    context: 'timeline',
  };

  // 模型对正文判否（真实 Jev 在纯正文上就是 0.2 左右）→ 仍然隐藏成待确认，不动作
  const denied = harness({ answers: answersFor({ adult: 0.21, cat: 'ordinary', conf: 0.64 }) });
  const deniedDecision = await denied.pipeline.decide(sample);
  assert.equal(deniedDecision.source, 'jev', '必须真的问过模型（说明预筛把它判成了候选）');
  assert.equal(deniedDecision.band, 'review');
  assert.ok(deniedDecision.reasons.includes('profile_solicitation'));
  assert.equal(deniedDecision.accountAction.kind, 'none');
  assert.ok(deniedDecision.prefilter.strongNameHit);
  assert.ok(deniedDecision.prefilter.nameReasons.includes('zh_solicit_jiaofu'));

  // 模型确认是色情引流 → 走到 block（可静音/拉黑）
  const confirmed = harness({ answers: answersFor({ adult: 0.96, sol: 0.93, cat: 'adult_solicitation', conf: 0.95 }) });
  const confirmedDecision = await confirmed.pipeline.decide(sample);
  assert.equal(confirmedDecision.band, 'block');
  assert.equal(confirmedDecision.accountAction.kind, 'mute');
});

test('文案农场：同一段文案被 2 个账号刷出 → 第二条起隐藏并打上 farm 标记', async () => {
  const { pipeline } = harness({ answers: scriptedAnswers({ junk: 0.54 }) });
  const base = { displayName: '靖柏🌸', text: '应该没人比我玩的开了吧🤣💖我福不黑不信你看', media: [], context: 'reply' };
  const d1 = await pipeline.decide({ ...base, id: 'f1', handle: 'ThomasTurnyysr' });
  const d2 = await pipeline.decide({ ...base, id: 'f2', handle: 'TinaMysersyro' });
  const d3 = await pipeline.decide({ ...base, id: 'f3', handle: 'TimothyAndjqqx' });
  assert.equal(d1.band, 'ignore', '第一条时农场还不成立（模型也说不确定 0.54）');
  assert.equal(d2.band, 'hide', '两个账号发同一段长文案即成立');
  assert.ok(d2.reasons.includes('farm_repeat'));
  assert.equal(d2.farm.hit, true);
  assert.equal(d2.farm.accounts, 2);
  assert.equal(d3.band, 'hide');
  assert.equal(d3.farm.accounts, 3);
  assert.equal(d3.accountAction.kind, 'none', '默认不因农场静音');
  assert.equal(pipeline.stats().farmHits, 2);
});

test('真站样本：emoji 拆字（处🐕男）+ 显示名黑话（处男免费）→ 两条都隐藏，默认不动作', async () => {
  const { pipeline, actions } = harness({ answers: scriptedAnswers({ junk: 0.7, full: answersFor({ adult: 0.74, cat: 'adult_solicitation', conf: 0.25 }) }) });
  const first = await pipeline.decide({
    id: 'e1',
    handle: 'czex7Jacquline',
    displayName: '不药而愈丶❤️处男免费❤️',
    text: '祝你有美好的一天🟧处🐕男🚹恭喜 发财',
    media: [],
    context: 'reply',
  });
  assert.equal(first.source, 'jev', '预筛命中（emoji 拆字仍被去符号后匹配到）→ 直接走四问，不再依赖预检');
  assert.equal(first.prefilter.score >= 2, true, `本地特征分 ${first.prefilter.score}`);
  assert.equal(first.band, 'hide', 'adult 0.74 ≥ hideNoul 0.65 但类别置信度只有 0.25 → 只隐藏');
  assert.equal(first.accountAction.kind, 'none');
  assert.equal(actions.length, 0);

  const second = await pipeline.decide({
    id: 'e2',
    handle: 'KhadijahLo9err',
    displayName: 'ヾ、 秂鴇銘❤️处男免费❤️',
    text: '祝你有美好的一天🐊处🔪男恭喜 发财',
    media: [],
    context: 'reply',
  });
  assert.equal(second.farm.hit, true, '归一化后正文完全相同 → 农场命中');
  assert.equal(second.band, 'hide');
  assert.equal(second.accountAction.kind, 'none', '农场不账号动作（I1）');
});

test('文案农场 + 「隐藏档也静音」→ 农场账号被静音（仅用户显式打开时）', async () => {
  const { pipeline } = harness({
    answers: scriptedAnswers({ junk: 0.54 }),
    settingsPatch: { action: { ...DEFAULT_SETTINGS.action, dryRun: false, autoMute: true, muteOnHide: true } },
  });
  const base = { displayName: '乐乐❤️处男无偿❤️', text: '太阳射☀️不进去的地方💪你可以', media: [], context: 'reply' };
  await pipeline.decide({ ...base, id: 'g1', handle: 'lisa82am4' });
  await pipeline.decide({ ...base, id: 'g2', handle: 'marie61ff2' });
  const third = await pipeline.decide({ ...base, id: 'g3', handle: 'lori73sv6' });
  assert.equal(third.band, 'hide');
  assert.equal(third.accountAction.kind, 'mute');
  assert.equal(third.accountAction.execute, true);
  assert.equal(third.accountAction.hideBand, true);
});

test('关掉农场检测 → 同样的刷屏不再命中', async () => {
  const { pipeline } = harness({
    answers: scriptedAnswers({ junk: 0.54 }),
    settingsPatch: { farm: { enabled: false } },
  });
  const base = { text: '应该没人比我玩的开了吧🤣💖我福不黑不信你看', media: [], context: 'reply' };
  for (const [i, handle] of ['a1', 'a2', 'a3'].entries()) {
    const d = await pipeline.decide({ ...base, id: `n${i}`, handle });
    assert.equal(d.band, 'ignore', `第 ${i + 1} 条`);
    assert.equal(d.farm, null);
  }
});

test('缓存指纹覆盖动作与预检/农场配置：切换「自动静音」后必须重新判定', async () => {
  const spy = { decide: async () => ({ band: 'hide' }) };
  const { pipeline, jev, setSettings } = harness({
    answers: scriptedAnswers({ junk: 0.05, full: answersFor({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.94 }) }),
  });
  const first = await pipeline.decide(SPAM_TWEET);
  assert.equal(first.accountAction.execute, false, '默认演练模式');

  // 只在弹窗里改「武装动作」（这正是端到端场景 D 做的事）
  setSettings({ action: { ...DEFAULT_SETTINGS.action, dryRun: false, autoMute: true, muteOnHide: true } });
  const second = await pipeline.decide(SPAM_TWEET);
  assert.equal(second.source, 'jev', '设置变了就不能复用缓存');
  assert.equal(second.accountAction.execute, true, '新的动作配置必须生效');
  assert.equal(jev.calls.length, 2, `应重新调用模型，实际 ${jev.calls.length}`);
});

/**
 * β 的本地分支：「情绪 / 认同 / 确认」这类低信息量附和，同一线程只留最早一条。
 * 它和模型版 β 一样**只做展示**：不改变 band、不改变 accountAction（不变量 I1）。
 */
const REPLY = (id, handle, text, seq) => ({
  id,
  handle,
  text,
  media: [],
  context: 'reply',
  threadId: '1900000000000000001',
  seq,
});

test('低信息量附和：同线程第二条起才折叠，且只折叠同类', async () => {
  const { pipeline } = harness({ settingsPatch: { semantics: { ...DEFAULT_SETTINGS.semantics, enabled: true, beta: { ...DEFAULT_SETTINGS.semantics.beta, enabled: true } } } });
  const first = await pipeline.decide(REPLY('a1', 'reply_a', '认同'));
  const second = await pipeline.decide(REPLY('a2', 'reply_b', '确定'));
  const third = await pipeline.decide(REPLY('a3', 'reply_c', '确实'));
  const substantive = await pipeline.decide(REPLY('a4', 'reply_d', '我不同意，公开数据其实是反过来的，去年同类政策让成本涨了三成'));

  assert.equal(first.beta, null, '第一条是代表条，自己不折叠');
  assert.equal(second.beta, null, '「确定」和「认同」不是同一类 → 不折叠');
  assert.equal(third.beta?.kind, 'agreement');
  assert.equal(third.beta?.folded, true, '「确实」与「确定」同类 → 折叠');
  assert.equal(third.beta?.duplicateOf, 'a2', '指向同类里最早的那条');
  assert.equal(third.beta?.groupSize, 2);
  assert.equal(substantive.beta, null, '讲事情的回复绝不折叠');

  // 纯展示：band 与账号动作不受影响
  for (const d of [first, second, third, substantive]) {
    assert.equal(d.band, 'ignore');
    assert.equal(d.accountAction?.kind ?? 'none', 'none', '只跳过判定，不产生任何账号动作');
  }
});

test('关掉「折叠情绪/认同/确认类附和」开关后不再折叠', async () => {
  const beta = { ...DEFAULT_SETTINGS.semantics.beta, enabled: true, foldLowSignal: false };
  const { pipeline } = harness({ settingsPatch: { semantics: { ...DEFAULT_SETTINGS.semantics, enabled: true, beta } } });
  await pipeline.decide(REPLY('b1', 'reply_a', '认同'));
  const second = await pipeline.decide(REPLY('b2', 'reply_b', '同意'));
  assert.equal(second.beta, null, '开关关掉后不折叠');
});

test('时间线上的低信息量附和（没有 threadId）不折叠：宁可少折叠', async () => {
  const { pipeline } = harness({ settingsPatch: { semantics: { ...DEFAULT_SETTINGS.semantics, enabled: true, beta: { ...DEFAULT_SETTINGS.semantics.beta, enabled: true } } } });
  const timeline = { id: 'c1', handle: 'x', text: '认同', media: [], context: 'timeline', threadId: null };
  const first = await pipeline.decide(timeline);
  const second = await pipeline.decide({ ...timeline, id: 'c2', handle: 'y', text: '同意' });
  assert.equal(first.beta, null);
  assert.equal(second.beta, null, '时间线不折叠（只按线程归组）');
});
