/**
 * 判定融合 + 动作规划（纯函数，全部可单测）。
 *
 * 三条不可协商的不变量：
 * I1. 只有 Jev 的强判定（类别 ∈ {adult_porn, adult_solicitation}）且成人概率与类别
 *     置信度都过闸，才可能触发拉黑/静音；预筛命中、肤色启发式、视觉模型**单独**
 *     都不能触发账号级动作（它们最多把推文隐藏成「待确认」）。
 * I2. 低置信度不会被「修补」成高置信度：模型不确定时只会降级为 review。
 * I3. 任何降级都会把原因写进 reasons，UI 与审计日志据此可解释。
 */
import { BORDERLINE_CATEGORIES, CATEGORY, STRONG_CATEGORIES } from './classifier.js';

export const BAND = {
  block: 'block',
  hide: 'hide',
  review: 'review',
  ignore: 'ignore',
};

export const BAND_LABEL = {
  block: '高置信度：隐藏 + 可执行账号动作',
  hide: '隐藏',
  review: '隐藏（待确认，不动作）',
  ignore: '放行',
};

export const REASON_LABEL = {
  adult_porn_high_confidence: '模型高置信度判定为色情内容',
  adult_solicitation_high_confidence: '模型高置信度判定为色情引流/交易',
  dual_confirmation_block: '两条独立判定互相印证（色情 + 站外引流）',
  off_platform_solicitation: '站外引流（Telegram/微信/外链）',
  adult_probability_high: '成人概率极高（类别未定）',
  category_confident: '类别判定置信度达标',
  prefilter_strong: '本地强特征命中',
  prefilter_weak: '本地弱特征命中',
  media_skin_dominant: '图片肤色占比极高',
  media_skin_suspicious: '图片肤色占比可疑',
  vision_model_adult: '视觉模型判定为成人图像',
  low_confidence_review: '模型不确定，降级为待确认',
  profile_solicitation: '账号显示名本身就是色情引流（先隐藏待确认）',
  adult_bait_probe: '预检：模型认为这是成人内容诱饵/性暗示自夸（先隐藏待确认）',
  farm_repeat: '文案农场：同一段文案被多个账号在短时间内复制刷屏',
  too_short_with_media: '纯图片/纯链接推文',
  budget_exhausted: '已达调用预算',
  model_error: '模型调用失败，降级为待确认',
  schema_invalid: '模型回答不合规，降级为待确认',
};

function reasonList(ids) {
  return [...new Set(ids)];
}

export function describeReasons(ids = []) {
  return ids.map((id) => REASON_LABEL[id] ?? id);
}

/**
 * @param {object} a readAnswers() 的结果
 * @param {object} signals { prefilterScore, prefilterReasons, mediaSuspicious, mediaBlocked, mediaSkinRatio, visionAdultProb, visionConfidence, degraded }
 * @param {object} settings normalizeSettings() 的结果
 */
export function decide(a, signals = {}, settings) {
  const T = settings.thresholds;
  const score = signals.prefilterScore ?? 0;
  const strongCat = STRONG_CATEGORIES.includes(a.category);
  const borderline = BORDERLINE_CATEGORIES.includes(a.category);
  const prefilterStrong = score >= 3;
  const mediaBlocked = Boolean(signals.mediaBlocked);
  const mediaSuspicious = Boolean(signals.mediaSuspicious);

  const base = {
    band: BAND.ignore,
    reasons: [],
    detail: {
      adult: a.adult,
      solicitation: a.solicitation,
      category: a.category,
      categoryConfidence: a.categoryConfidence,
      severity: a.severity,
      prefilterScore: score,
      mediaSkinRatio: signals.mediaSkinRatio ?? null,
      visionAdultProb: signals.visionAdultProb ?? null,
    },
  };

  const set = (band, reasons) => ({ ...base, band, reasons: reasonList(reasons) });

  // ---- I1：拉黑只可能来自强类别 + 双闸门 ----
  const catReason = a.category === CATEGORY.adultPorn ? 'adult_porn_high_confidence' : 'adult_solicitation_high_confidence';
  if (a.category === CATEGORY.adultSolicitation && a.solicitation >= 0.9 && a.adult >= T.blockNoul && a.categoryConfidence >= T.blockConfidence) {
    return set(BAND.block, [catReason, 'off_platform_solicitation']);
  }
  if (strongCat && a.adult >= T.blockNoul && a.categoryConfidence >= T.blockConfidence) {
    return set(BAND.block, [catReason, ...(prefilterStrong ? ['prefilter_strong'] : [])]);
  }
  // 双确认：两个互相独立的问题同时高，且类别置信度极高 —— 商业色情推广的常见形态
  // （真实 Jev 对「OnlyFans 打折 / 链接在简介」给出约 0.85，单条 Noul 达不到 0.9）。
  if (strongCat && a.adult >= T.dualAdult && a.solicitation >= T.dualSolicitation && a.categoryConfidence >= T.dualConfidence) {
    return set(BAND.block, [catReason, 'dual_confirmation_block', 'off_platform_solicitation']);
  }

  // ---- 隐藏：高置信度但不满足拉黑闸门 ----
  if (strongCat && a.adult >= T.hideNoul) return set(BAND.hide, [catReason, ...(prefilterStrong ? ['prefilter_strong'] : [])]);
  if (strongCat && a.categoryConfidence >= T.hideConfidence && a.adult >= 0.5) {
    return set(BAND.hide, [catReason, 'category_confident']);
  }
  if (a.adult >= 0.9 && a.categoryConfidence >= 0.5) return set(BAND.hide, ['adult_probability_high']);
  if (a.solicitation >= 0.9 && a.adult >= T.blockNoul) return set(BAND.hide, ['off_platform_solicitation', 'adult_probability_high']);
  if (mediaBlocked && (a.adult >= 0.5 || score >= 2)) {
    return set(BAND.hide, ['media_skin_dominant', ...(score >= 2 ? ['prefilter_weak'] : [])]);
  }
  if (mediaSuspicious && a.solicitation >= 0.8) return set(BAND.hide, ['media_skin_suspicious', 'off_platform_solicitation']);
  // 文案农场：同一段无实质内容的话被 N 个账号短时间内复制 —— 结构性强证据。
  // 仍要求至少有一条色情/诱饵信号，避免把「同一句新闻标题」误伤成 spam。
  if (
    signals.farmHit &&
    ((signals.baitProbability ?? 0) >= T.farmBaitMin || a.adult >= T.farmAdultMin || score >= 1)
  ) {
    return set(BAND.hide, ['farm_repeat', ...(score >= 1 ? ['prefilter_weak'] : [])]);
  }
  if (signals.visionAdultProb !== null && signals.visionAdultProb !== undefined && signals.visionAdultProb >= 0.9 && (signals.visionConfidence ?? 0) >= 0.7) {
    return set(BAND.hide, ['vision_model_adult']);
  }

  // ---- 待确认：模型不确定，或只有媒体/预筛信号 ----
  if (a.adult >= 0.5) return set(BAND.review, ['low_confidence_review']);
  if (borderline && a.adult >= T.hideNoul) return set(BAND.review, ['low_confidence_review']);
  // 纯图片黄推（文案只有一两个字 / 只有链接）：Jev 看不了图，文本判定必然偏低，
  // 此时「图片裸露 + 这是只发图的形态」就是唯一可用证据 —— 只隐藏成待确认，绝不动作。
  if (mediaBlocked && signals.shortWithMedia) return set(BAND.review, ['media_skin_dominant', 'too_short_with_media']);
  if (mediaSuspicious && score >= 2) return set(BAND.review, ['media_skin_suspicious', 'prefilter_weak']);
  // 显示名本身就是色情引流（如「🍑真实同城约p🍑主页联系🔞免费」，正文却写得无害）：
  // 即使模型对正文判否，也只隐藏成待确认 —— 纯本地特征永不升级为账号动作（I1）。
  if (signals.strongNameHit) {
    return set(BAND.review, ['profile_solicitation', ...(prefilterStrong ? ['prefilter_strong'] : [])]);
  }
  // 预检命中：模型在「完全没被本地词表命中」的推文上认出成人诱饵原型。
  // 这是召回的主力，但它只给待确认档 —— 账号级动作仍然只认完整四问的强类别（I1）。
  if (typeof signals.baitProbability === 'number' && signals.baitProbability >= T.baitReview) {
    return set(BAND.review, ['adult_bait_probe']);
  }
  // 模型不可用时：「本地已有信号」才隐藏成待确认，否则宁可放行，
  // 避免一次接口抖动把整条时间线都盖掉。
  if (signals.degraded) return set(score >= 2 ? BAND.review : BAND.ignore, [signals.degraded]);

  // ---- 放行 ----
  return set(BAND.ignore, []);
}

/**
 * 动作规划：把「判定」翻译成「要不要真的点静音/拉黑」。
 * 破坏性动作受三重约束：判定带必须是 block、必须已关闭演练、必须还有预算。
 */
export function planAccountAction({ band, settings, budgetRemaining = Infinity, handle = '' }) {
  const act = settings.action;
  const kind = act.autoBlock ? (act.autoMute ? 'both' : 'block') : act.autoMute ? 'mute' : 'none';
  const out = { kind: 'none', execute: false, dryRun: Boolean(act.dryRun), reason: null, handle };

  // 只有 block 档才允许动作；除非用户显式打开「隐藏档也静音」。
  const allowedBands = act.muteOnHide ? [BAND.block, BAND.hide] : [BAND.block];
  if (!allowedBands.includes(band)) {
    out.reason = 'band_below_block';
    return out;
  }
  // 「隐藏档也静音」时只静音，不拉黑（更激进的动作仍只认 block 档）。
  const effectiveKind = band === BAND.hide ? (act.autoMute ? 'mute' : 'none') : kind;
  // 连作者都没解析出来时不做不可逆动作：黑名单无从记录、审计也对不上账。
  if (!handle) {
    out.reason = 'unknown_handle';
    return out;
  }
  if (effectiveKind === 'none') {
    out.reason = 'no_action_configured';
    return out;
  }
  out.kind = effectiveKind;
  out.hideBand = band === BAND.hide;
  if (act.dryRun) {
    out.reason = 'dry_run';
    return out;
  }
  if (budgetRemaining <= 0) {
    out.reason = 'budget_exhausted';
    return out;
  }
  out.execute = true;
  out.reason = 'armed';
  return out;
}
