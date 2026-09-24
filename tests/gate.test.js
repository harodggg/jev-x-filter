import test from 'node:test';
import assert from 'node:assert/strict';
import { BAND, decide, planAccountAction } from '../src/sw/gate.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/sw/settings.js';

const settings = normalizeSettings(DEFAULT_SETTINGS);

/** readAnswers() 的形状。默认危害程度 2.5（够到隐藏/动作的程度线）。 */
function answers({ adult = 0, sol = 0, dec = 0, cat = 'ordinary', conf = 0, sev = 2.5 } = {}) {
  return {
    adult,
    solicitation: sol,
    deceptive: dec,
    category: cat,
    categoryProbabilities: null,
    categoryConfidence: conf,
    severity: sev,
    severityConfidence: 0,
  };
}

test('强类别 + 双闸门 → block', () => {
  const d = decide(answers({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }), { prefilterScore: 3 }, settings);
  assert.equal(d.band, BAND.block);
  assert.ok(d.reasons.includes('category:adult_porn'));
  assert.ok(d.reasons.includes('adult_high'));
  assert.ok(d.reasons.includes('prefilter_strong'));
});

test('色情概率高但类别置信度不足 → 只隐藏，不 block', () => {
  const d = decide(answers({ adult: 0.95, cat: 'adult_porn', conf: 0.4 }), { prefilterScore: 3 }, settings);
  assert.equal(d.band, BAND.hide);
});

test('引流转发：站外引流 + 成人概率高 → block', () => {
  const d = decide(answers({ adult: 0.93, sol: 0.97, cat: 'adult_solicitation', conf: 0.8 }), { prefilterScore: 3 }, settings);
  assert.equal(d.band, BAND.block);
  assert.ok(d.reasons.includes('category:adult_solicitation'));
  assert.ok(d.reasons.includes('adult_high'));
});

test('类别判成普通但成人概率极高 → 隐藏', () => {
  const d = decide(answers({ adult: 0.93, cat: 'other', conf: 0.6 }), { prefilterScore: 0 }, settings);
  assert.equal(d.band, BAND.hide);
  assert.ok(d.reasons.includes('adult_probability_high'));
});

test('模型不确定（成人概率 0.6）→ 待确认，不动作', () => {
  const d = decide(answers({ adult: 0.6, cat: 'suggestive', conf: 0.3 }), { prefilterScore: 3 }, settings);
  assert.equal(d.band, BAND.review);
  assert.equal(planAccountAction({ band: d.band, settings, budgetRemaining: 10, handle: 'x' }).kind, 'none');
});

test('不变量 I1：仅预筛命中、模型说不是 → 放行', () => {
  const d = decide(answers({ adult: 0.1, cat: 'ordinary', conf: 0.9 }), { prefilterScore: 5 }, settings);
  assert.equal(d.band, BAND.ignore);
});

test('不变量 I1：图片信号不构成账号级动作，最多隐藏', () => {
  // 只有图片信号、没有本地文案信号 → 连隐藏都不做（模型没给出文本层面的证据）
  const onlyMedia = decide(answers({}), { prefilterScore: 0, mediaSuspicious: true, mediaBlocked: true }, settings);
  assert.equal(onlyMedia.band, BAND.ignore);
  assert.notEqual(onlyMedia.band, BAND.block);

  // 图片信号 + 本地文案命中 → 可以隐藏，但永不进入 block 档
  const withText = decide(answers({ adult: 0.6, cat: 'ordinary', conf: 0.4 }), { prefilterScore: 3, mediaBlocked: true }, settings);
  assert.equal(withText.band, BAND.hide);
  assert.notEqual(withText.band, BAND.block);

  // 只有弱文案 + 可疑图片 → 待确认
  const review = decide(answers({}), { prefilterScore: 2, mediaSuspicious: true }, settings);
  assert.equal(review.band, BAND.review);
});

test('不变量 I1：视觉模型单独命中 → 只隐藏', () => {
  const d = decide(answers({}), { prefilterScore: 0, visionAdultProb: 0.98, visionConfidence: 0.9 }, settings);
  assert.equal(d.band, BAND.hide);
});

test('模型不可用时：有本地信号 → 待确认；无信号 → 放行', () => {
  assert.equal(decide(answers({}), { prefilterScore: 3, degraded: 'model_error' }, settings).band, BAND.review);
  assert.equal(decide(answers({}), { prefilterScore: 0, degraded: 'model_error' }, settings).band, BAND.ignore);
});

test('动作规划：默认演练模式不执行', () => {
  const plan = planAccountAction({ band: BAND.block, settings, budgetRemaining: 5, handle: 'spam' });
  assert.equal(plan.kind, 'mute');
  assert.equal(plan.execute, false);
  assert.equal(plan.reason, 'dry_run');
});

test('动作规划：关闭演练且预算充足才执行', () => {
  const armed = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false } });
  const plan = planAccountAction({ band: BAND.block, settings: armed, budgetRemaining: 5, handle: 'spam' });
  assert.equal(plan.execute, true);
  assert.equal(plan.reason, 'armed');

  const exhausted = planAccountAction({ band: BAND.block, settings: armed, budgetRemaining: 0, handle: 'spam' });
  assert.equal(exhausted.execute, false);
  assert.equal(exhausted.reason, 'budget_exhausted');
});

test('动作规划：autoBlock 优先级与 both 组合', () => {
  const blockOnly = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, autoBlock: true, autoMute: false, dryRun: false } });
  assert.equal(planAccountAction({ band: BAND.block, settings: blockOnly, budgetRemaining: 1, handle: 'spam' }).kind, 'block');
  const both = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, autoBlock: true, autoMute: true, dryRun: false } });
  assert.equal(planAccountAction({ band: BAND.block, settings: both, budgetRemaining: 1, handle: 'spam' }).kind, 'both');
  const none = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, autoBlock: false, autoMute: false, dryRun: false } });
  const plan = planAccountAction({ band: BAND.block, settings: none, budgetRemaining: 1, handle: 'spam' });
  assert.equal(plan.kind, 'none');
  assert.equal(plan.reason, 'no_action_configured');
});

test('动作规划：非 block 档位一律不动作', () => {
  const armed = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false } });
  for (const band of [BAND.hide, BAND.review, BAND.ignore]) {
    assert.equal(planAccountAction({ band, settings: armed, budgetRemaining: 10 }).kind, 'none', band);
  }
});

test('双确认：两条独立 Noul 同时过关才升级为 block（商业色情推广）', () => {
  // 真实 Jev 对「OnlyFans 打折 / 链接在简介」给出约 adult 0.85 / solicitation 0.86 / 类别置信度 0.96
  const dual = decide(answers({ adult: 0.85, sol: 0.86, cat: 'adult_solicitation', conf: 0.96 }), { prefilterScore: 3 }, settings);
  assert.equal(dual.band, BAND.block);
  assert.ok(dual.reasons.includes('dual_confirmation_block'));

  // 只有一条高：仍然是 hide（单条阈值 0.9 不变松）
  const singleHigh = decide(answers({ adult: 0.85, sol: 0.4, cat: 'adult_solicitation', conf: 0.96 }), { prefilterScore: 3 }, settings);
  assert.equal(singleHigh.band, BAND.hide);

  // 类别置信度不够：也只是 hide
  const lowConf = decide(answers({ adult: 0.85, sol: 0.86, cat: 'adult_solicitation', conf: 0.7 }), { prefilterScore: 0 }, settings);
  assert.equal(lowConf.band, BAND.hide);

  // 弱类别（suggestive）不走双确认路径
  const borderline = decide(answers({ adult: 0.85, sol: 0.86, cat: 'suggestive', conf: 0.99 }), { prefilterScore: 0 }, settings);
  assert.notEqual(borderline.band, BAND.block);
});

test('纯图片黄推（短文案 + 强图片信号）→ 待确认，永不动作', () => {
  const d = decide(answers({ adult: 0.21, cat: 'ordinary', conf: 0.61 }), { prefilterScore: 0, mediaBlocked: true, mediaSuspicious: true, shortWithMedia: true }, settings);
  assert.equal(d.band, BAND.review, 'Jev 看不了图，此时只能靠「只发图形态 + 图片裸露」隐藏成待确认');
  assert.ok(d.reasons.includes('too_short_with_media'));
  assert.equal(planAccountAction({ band: d.band, settings, budgetRemaining: 10, handle: 'x' }).kind, 'none');

  // 强图片信号但文案信息量足够（不是纯图形态）→ 不隐藏
  const longText = decide(answers({ adult: 0.21, cat: 'ordinary', conf: 0.61 }), { prefilterScore: 0, mediaBlocked: true, mediaSuspicious: true, shortWithMedia: false }, settings);
  assert.equal(longText.band, BAND.ignore);
});

test('诈骗类：欺骗概率 + 程度达标 → block（可动账号）', () => {
  const scam = decide(answers({ dec: 0.92, cat: 'scam', conf: 0.88, sev: 3 }), { prefilterScore: 3 }, settings);
  assert.equal(scam.band, BAND.block);
  assert.ok(scam.reasons.includes('deceptive_high'));
  assert.ok(scam.reasons.includes('category:scam'));
});

test('标题党与低质类：即使置信度极高也只隐藏，永不 block', () => {
  for (const cat of ['clickbait', 'low_quality']) {
    const d = decide(answers({ cat, conf: 0.99, sev: 3, dec: 0.9 }), { prefilterScore: 3 }, settings);
    assert.equal(d.band, BAND.hide, cat);
    assert.notEqual(d.band, BAND.block, cat);
    assert.equal(planAccountAction({ band: d.band, settings, budgetRemaining: 10, handle: 'x' }).kind, 'none', cat);
  }
});

test('类别被用户关掉 → 放行且写明原因（宁可漏杀不可误杀）', () => {
  const scoped = normalizeSettings({ ...DEFAULT_SETTINGS, categories: { ...DEFAULT_SETTINGS.categories, scam: { enabled: false } } });
  const d = decide(answers({ dec: 0.99, cat: 'scam', conf: 0.95, sev: 3.5 }), { prefilterScore: 3 }, scoped);
  assert.equal(d.band, BAND.ignore);
  assert.ok(d.reasons.includes('category_disabled'));
  assert.equal(d.detail.categoryEnabled, false);
});

test('色情组关掉后，色情相关的所有隐藏路径都失效（含兜底）', () => {
  const scoped = normalizeSettings({ ...DEFAULT_SETTINGS, categories: { ...DEFAULT_SETTINGS.categories, adult: { enabled: false } } });
  // 模型强判定
  assert.equal(decide(answers({ adult: 0.97, cat: 'adult_porn', conf: 0.9, sev: 3 }), { prefilterScore: 3 }, scoped).band, BAND.ignore);
  // 兜底：成人概率 0.6 也不再进待确认
  assert.equal(decide(answers({ adult: 0.6, cat: 'other', conf: 0.2, sev: 1 }), { prefilterScore: 0 }, scoped).band, BAND.ignore);
  // 显示名引流与图片信号同样失效
  assert.equal(decide(answers({}), { prefilterScore: 3, strongNameHit: true }, scoped).band, BAND.ignore);
  assert.equal(decide(answers({}), { prefilterScore: 3, mediaBlocked: true, mediaSuspicious: true }, scoped).band, BAND.ignore);
  // 其它类别不受影响
  assert.equal(decide(answers({ dec: 0.95, cat: 'scam', conf: 0.9, sev: 3 }), { prefilterScore: 3 }, scoped).band, BAND.block);
});

test('危害程度不足时不会进入动作档（程度是硬门槛）', () => {
  const low = decide(answers({ adult: 0.99, cat: 'adult_porn', conf: 0.95, sev: 1 }), { prefilterScore: 3 }, settings);
  assert.notEqual(low.band, BAND.block);
  assert.equal(low.band, BAND.hide, 'severe 内容判定但程度=1 → 只隐藏');
});

test('reasons 始终可解释（无重复、有标签）', () => {
  const d = decide(answers({ adult: 0.97, cat: 'adult_porn', conf: 0.9 }), { prefilterScore: 3 }, settings);
  assert.equal(new Set(d.reasons).size, d.reasons.length);
  assert.ok(d.reasons.every((r) => typeof r === 'string' && r.length > 0));
});

test('显示名本身就是色情引流 → 最多隐藏待确认，绝不 block（即使模型判否）', () => {
  const denied = decide(answers({ adult: 0.05, sol: 0.02, cat: 'ordinary', conf: 0.9 }), { prefilterScore: 6, strongNameHit: true }, settings);
  assert.equal(denied.band, BAND.review);
  assert.ok(denied.reasons.includes('profile_solicitation'));
  assert.equal(planAccountAction({ band: denied.band, settings, budgetRemaining: 10, handle: 'x' }).kind, 'none');
});

test('作者无法解析时不做账号动作', () => {
  const armed = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false } });
  const plan = planAccountAction({ band: BAND.block, settings: armed, budgetRemaining: 10, handle: '' });
  assert.equal(plan.kind, 'none');
  assert.equal(plan.reason, 'unknown_handle');
});

test('预检命中只到待确认：即使诱饵概率 1.0 也绝不 block', () => {
  const review = decide(answers({}), { prefilterScore: 0, junkProbability: 0.8, triageProbed: true }, settings);
  assert.equal(review.band, BAND.review);
  assert.ok(review.reasons.includes('junk_probe'));
  assert.equal(planAccountAction({ band: review.band, settings, budgetRemaining: 10, handle: 'bot' }).kind, 'none');

  const max = decide(answers({}), { prefilterScore: 0, junkProbability: 1, triageProbed: true }, settings);
  assert.equal(max.band, BAND.review, '预检是召回手段，不是账号动作的依据（I1）');

  const low = decide(answers({}), { prefilterScore: 0, junkProbability: 0.2, triageProbed: true }, settings);
  assert.equal(low.band, BAND.ignore);
});

test('「隐藏档也静音」开关：默认不动作；打开后 hide 档只静音，绝不拉黑', () => {
  const hideBand = BAND.hide;

  const off = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false, muteOnHide: false } });
  const planOff = planAccountAction({ band: hideBand, settings: off, budgetRemaining: 10, handle: 'bot' });
  assert.equal(planOff.kind, 'none');
  assert.equal(planOff.reason, 'band_below_block');

  const on = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false, autoMute: true, muteOnHide: true } });
  const planOn = planAccountAction({ band: hideBand, settings: on, budgetRemaining: 10, handle: 'bot' });
  assert.equal(planOn.kind, 'mute');
  assert.equal(planOn.execute, true);
  assert.equal(planOn.hideBand, true);

  // 即使开了自动拉黑，hide 档也只静音（拉黑仍然只认 block 档）
  const aggressive = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: false, autoMute: true, autoBlock: true, muteOnHide: true } });
  const planAggressive = planAccountAction({ band: hideBand, settings: aggressive, budgetRemaining: 10, handle: 'bot' });
  assert.equal(planAggressive.kind, 'mute');
  assert.equal(planAccountAction({ band: BAND.block, settings: aggressive, budgetRemaining: 10, handle: 'bot' }).kind, 'both');

  // 演练模式仍然优先
  const dry = normalizeSettings({ ...DEFAULT_SETTINGS, action: { ...DEFAULT_SETTINGS.action, dryRun: true, autoMute: true, muteOnHide: true } });
  const planDry = planAccountAction({ band: hideBand, settings: dry, budgetRemaining: 10, handle: 'bot' });
  assert.equal(planDry.execute, false);
  assert.equal(planDry.reason, 'dry_run');
});

test('文案农场：命中即隐藏（有诱饵/色情/本地信号时），但不 block', () => {
  const farm = decide(answers({}), { prefilterScore: 0, farmHit: true, farmAccounts: 4, junkProbability: 0.54 }, settings);
  assert.equal(farm.band, BAND.hide);
  assert.ok(farm.reasons.includes('farm_repeat'));
  assert.notEqual(farm.band, BAND.block);

  // 2 个账号、没有任何内容侧信号 → 农场单独不动手（避免「两个人恰好发同一句长句」误伤）
  const weak = decide(answers({}), { prefilterScore: 0, farmHit: true, farmAccounts: 2, junkProbability: 0.05 }, settings);
  assert.equal(weak.band, BAND.ignore);
  // 3 个以上账号时，结构证据本身足够（见下一个测试）
  const many = decide(answers({}), { prefilterScore: 0, farmHit: true, farmAccounts: 4, junkProbability: 0.05 }, settings);
  assert.equal(many.band, BAND.hide);

  // 本地弱特征也算信号
  const withWeak = decide(answers({}), { prefilterScore: 1, farmHit: true, farmAccounts: 3, junkProbability: 0.05 }, settings);
  assert.equal(withWeak.band, BAND.hide);
});

test('农场结构证据：≥3 个账号时不再要求内容侧信号', () => {
  // 模型对单条文案只给 0.44（低于预检隐藏线），也没有本地命中 → 靠账号数兜住
  const three = decide(answers({}), { prefilterScore: 0, farmHit: true, farmAccounts: 3, junkProbability: 0.44 }, settings);
  assert.equal(three.band, BAND.hide);
  assert.ok(three.reasons.includes('farm_repeat'));

  // 只有 2 个账号且没有内容侧信号 → 不动手（避免「两个人恰好发同一句长句」误伤）
  const two = decide(answers({}), { prefilterScore: 0, farmHit: true, farmAccounts: 2, junkProbability: 0.05 }, settings);
  assert.equal(two.band, BAND.ignore);
});

/**
 * X 自己标的「可能的垃圾信息」分区（真站截图：正文只有三个字 `已老实` 的那条）。
 * 它是**结构信号**，不是内容证据：只能给到「隐藏成待确认」，绝不能动账号。
 */
test('X 的「可能的垃圾信息」分区 → 只到 review，不动账号', () => {
  const d = decide(answers({ adult: 0.2, cat: 'other', conf: 0.6 }), { xSpamSection: true, prefilterScore: 0 }, settings);
  assert.equal(d.band, BAND.review);
  assert.ok(d.reasons.includes('x_spam_section'));
  const action = planAccountAction({ band: d.band, settings, budgetRemaining: 100, handle: 'for520vox' });
  assert.equal(action.kind, 'none', '结构信号永不触发账号动作');
  assert.equal(action.execute, false);
});

test('实时内容证据强于 X 的分区信号：该 block 还是 block', () => {
  const d = decide(
    answers({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.9, sev: 3 }),
    { xSpamSection: true, prefilterScore: 3 },
    settings,
  );
  assert.equal(d.band, BAND.block, '分区信号不能让已经够格的判定降级');
  assert.ok(!d.reasons.includes('x_spam_section'));
});

/**
 * 已知引流黑话模板 → 本地 review 下限（模型对这些黑话常常给不出成人概率）。
 * 和 X 的分区信号一样：只隐藏成待确认，绝不据此动账号。
 */
test('引流黑话模板命中 → review（隐藏待确认），且不动账号', () => {
  const d = decide(answers({ adult: 0.03, cat: 'ordinary', conf: 0.6 }), { reviewFloor: true, prefilterScore: 3 }, settings);
  assert.equal(d.band, BAND.review);
  assert.ok(d.reasons.includes('solicit_template'));
  const action = planAccountAction({ band: d.band, settings, budgetRemaining: 100, handle: 'JonathanFifety' });
  assert.equal(action.kind, 'none');
  assert.equal(action.execute, false);
});

test('真实内容证据强于黑话模板：该 block 还是 block', () => {
  const d = decide(
    answers({ adult: 0.97, sol: 0.95, cat: 'adult_solicitation', conf: 0.9, sev: 3 }),
    { reviewFloor: true, prefilterScore: 3 },
    settings,
  );
  assert.equal(d.band, BAND.block);
});
