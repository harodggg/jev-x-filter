/**
 * 判定融合 + 动作规划（纯函数，全部可单测）。
 *
 * v0.3.0：从「黄推」升级为**信息过滤器**。判定主干是 Jev 给出的**类别**
 * （`categories.js` 单点定义），再叠加三条独立证据（色情 / 引流 / 欺骗）与程度分。
 *
 * 三条不可协商的不变量：
 * I1. 账号级动作（静音/拉黑）只可能来自「模型给出**可动账号**的类别 + 类别置信度达标 +
 *     程度达标 + 至少一条硬度证据（色情/欺骗/强引流）」。预筛命中、图片肤色、文案农场、
 *     视觉模型、预检信号**单独出现**都不能触发账号动作（它们最多到 hide / review）。
 * I2. 低置信度不会被「修补」成高置信度：模型不确定时只会降级为 review。
 * I3. 任何降级都会把原因写进 reasons，UI 与审计日志据此可解释。
 * 类别开关：用户关掉的类别一律不隐藏、不动作（宁可漏杀，不可误杀）。
 */
import {
  CATEGORY,
  categoryLabel,
  isAccountEligible,
  isCategoryEnabled,
  isHideable,
  normalizeCategory,
} from './categories.js';

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
  adult_high: '模型高置信度判定为色情内容',
  deceptive_high: '模型高置信度判定为欺骗/诈骗诱导',
  solicitation_high: '模型高置信度判定为站外/私域引流',
  dual_confirmation_block: '两条独立判定互相印证（色情 + 站外引流）',
  category_confident: '类别判定置信度达标',
  severity_high: '危害程度评分达标',
  off_platform_solicitation: '站外引流（Telegram/微信/外链/私信）',
  adult_probability_high: '成人概率极高',
  prefilter_strong: '本地强特征命中',
  prefilter_weak: '本地弱特征命中',
  media_skin_dominant: '图片肤色占比极高',
  media_skin_suspicious: '图片肤色占比可疑',
  vision_model_adult: '视觉模型判定为成人图像',
  low_confidence_review: '模型不确定，降级为待确认',
  profile_solicitation: '账号显示名本身就是色情引流（先隐藏待确认）',
  farm_repeat: '重复文案农场：同一段文案被多个账号在短时间内复制',
  repeat_in_post: '同一条推文里重复同一句话（刷屏特征）',
  junk_probe: '预检：模型认为这是垃圾/诈骗诱饵/低质填充（先隐藏待确认）',
  too_short_with_media: '纯图片/纯链接推文',
  budget_exhausted: '已达调用预算',
  model_error: '模型调用失败，降级为待确认',
  schema_invalid: '模型回答不合规，降级为待确认',
  category_disabled: '该类别已在设置里关闭',
};

function reasonList(ids) {
  return [...new Set(ids)];
}

/** 支持动态原因：`category:scam` → 「类别：诈骗/博彩/荐股」。 */
export function describeReasons(ids = []) {
  return ids.map((id) => {
    if (typeof id === 'string' && id.startsWith('category:')) {
      return `类别：${categoryLabel(id.slice('category:'.length))}`;
    }
    return REASON_LABEL[id] ?? id;
  });
}

/**
 * @param {object} a readAnswers() 的结果
 * @param {object} signals { prefilterScore, prefilterReasons, shortWithMedia, strongNameHit,
 *   farmHit, farmAccounts, mediaSuspicious, mediaBlocked, mediaSkinRatio, visionAdultProb,
 *   visionConfidence, junkProbability, degraded }
 * @param {object} settings normalizeSettings() 的结果
 */
export function decide(a, signals = {}, settings) {
  const T = settings.thresholds;
  const category = normalizeCategory(a?.category);
  const enabled = isCategoryEnabled(category, settings);
  const hideable = isHideable(category);
  const accountEligible = isAccountEligible(category);
  const confidence = a?.categoryConfidence ?? 0;
  const severity = a?.severity ?? 0;
  const adult = a?.adult ?? 0;
  const solicitation = a?.solicitation ?? 0;
  const deceptive = a?.deceptive ?? 0;
  const score = signals.prefilterScore ?? 0;
  const prefilterStrong = score >= 3;
  const mediaBlocked = Boolean(signals.mediaBlocked);
  const mediaSuspicious = Boolean(signals.mediaSuspicious);
  const junkProbability = typeof signals.junkProbability === 'number' ? signals.junkProbability : null;

  // 类别开关必须约束**所有**隐藏路径：关掉色情 → 色情相关的证据（成人概率、肤色、视觉模型、
  // 显示名引流）都不能再隐藏；关掉农场 → 结构信号也不能隐藏。
  const adultEnabled = isCategoryEnabled(CATEGORY.adultPorn, settings);
  const farmEnabled = settings?.categories?.farm?.enabled !== false;
  const anyEnabled = Object.values(settings?.categories ?? {}).some((group) => group?.enabled !== false);

  const base = {
    band: BAND.ignore,
    reasons: [],
    detail: {
      category,
      categoryLabel: categoryLabel(category),
      categoryEnabled: enabled,
      adult,
      solicitation,
      deceptive,
      categoryConfidence: confidence,
      severity,
      prefilterScore: score,
      mediaSkinRatio: signals.mediaSkinRatio ?? null,
      visionAdultProb: signals.visionAdultProb ?? null,
      junkProbability,
    },
  };

  const set = (band, reasons) => ({ ...base, band, reasons: reasonList(reasons) });
  const categoryReason = `category:${category}`;

  /* ---------------- 1) 账号级动作：只可能来自模型的强判定（I1） ---------------- */
  if (enabled && accountEligible && confidence >= T.blockConfidence && severity >= T.blockSeverity) {
    const hardEvidence = [];
    if (adult >= T.blockNoul) hardEvidence.push('adult_high');
    if (deceptive >= T.blockDeceptive) hardEvidence.push('deceptive_high');
    if (solicitation >= 0.9 && severity >= 2.5) hardEvidence.push('solicitation_high');
    // 双确认：两个互相独立的问题同时过关
    // （商业色情推广的典型形态：单条 noul 只有 0.85 左右，达不到 0.90）
    const dual = adult >= T.dualAdult && solicitation >= T.dualSolicitation && confidence >= T.dualConfidence;
    if (hardEvidence.length > 0 || dual) {
      return set(BAND.block, [
        categoryReason,
        ...hardEvidence,
        ...(dual ? ['dual_confirmation_block'] : []),
        ...(prefilterStrong ? ['prefilter_strong'] : []),
      ]);
    }
  }

  /* ---------------- 2) 结构信号：永不触发账号动作 ---------------- */
  // 重复文案农场：同一段无实质内容的话被多个账号短时间复制。
  // 仍要求至少一条内容侧信号，避免把「同一句新闻标题」误伤成 spam。
  // 3 个以上不同账号发同一段（近似）无实质内容的话，本身就是足够强的结构证据，
  // 不再要求额外的内容侧信号 —— 真站样本里模型对单条只给 0.44，靠这一条兜住。
  if (farmEnabled && signals.farmHit && (signals.farmAccounts ?? 0) >= 3) {
    return set(BAND.hide, ['farm_repeat', ...(score >= 1 ? ['prefilter_weak'] : [])]);
  }
  if (
    farmEnabled &&
    signals.farmHit &&
    (adult >= T.farmAdultMin ||
      deceptive >= T.farmAdultMin ||
      solicitation >= 0.6 ||
      score >= 1 ||
      (junkProbability !== null && junkProbability >= T.farmBaitMin))
  ) {
    return set(BAND.hide, ['farm_repeat', ...(score >= 1 ? ['prefilter_weak'] : [])]);
  }
  if (adultEnabled && mediaBlocked && (adult >= 0.5 || score >= 2)) {
    return set(BAND.hide, ['media_skin_dominant', ...(score >= 2 ? ['prefilter_weak'] : [])]);
  }
  if (adultEnabled && mediaSuspicious && solicitation >= 0.8) {
    return set(BAND.hide, ['media_skin_suspicious', 'off_platform_solicitation']);
  }
  if (adultEnabled && signals.visionAdultProb !== null && signals.visionAdultProb !== undefined && signals.visionAdultProb >= 0.9 && (signals.visionConfidence ?? 0) >= 0.7) {
    return set(BAND.hide, ['vision_model_adult']);
  }

  /* ---------------- 3) 模型判定：隐藏 / 待确认 ---------------- */
  // 色情概率极高 + 类别有把握时，即使类别落在「普通/无法归类」，也隐藏（色情证据本身就够）。
  // 仍然受「色情」这一组开关约束 —— 用户关掉了就不隐藏。
  if (adultEnabled && adult >= 0.9 && confidence >= 0.5) {
    return set(BAND.hide, [categoryReason, 'adult_probability_high']);
  }
  if (enabled && hideable) {
    if (confidence >= T.hideConfidence || severity >= T.hideSeverity) {
      return set(BAND.hide, [categoryReason, 'category_confident', ...(prefilterStrong ? ['prefilter_strong'] : [])]);
    }
    if (adult >= 0.9) return set(BAND.hide, [categoryReason, 'adult_probability_high']);
    if (solicitation >= 0.9 && severity >= T.hideSeverity) {
      return set(BAND.hide, [categoryReason, 'off_platform_solicitation']);
    }
    if (severity >= T.hideSeverity || confidence >= T.reviewConfidence) {
      return set(BAND.review, [categoryReason, 'low_confidence_review']);
    }
  }

  /* ---------------- 4) 内容侧证据不足时的兜底：只到待确认 ---------------- */
  if (adultEnabled && signals.strongNameHit) {
    return set(BAND.review, ['profile_solicitation', ...(prefilterStrong ? ['prefilter_strong'] : [])]);
  }
  if (anyEnabled && junkProbability !== null && junkProbability >= T.junkReview) {
    return set(BAND.review, ['junk_probe']);
  }
  if (adultEnabled && mediaBlocked && signals.shortWithMedia) {
    return set(BAND.review, ['media_skin_dominant', 'too_short_with_media']);
  }
  if (adultEnabled && mediaSuspicious && score >= 2) {
    return set(BAND.review, ['media_skin_suspicious', 'prefilter_weak']);
  }
  if (adultEnabled && adult >= 0.5) return set(BAND.review, ['low_confidence_review']);
  // 模型不可用时：「本地已有信号」才隐藏成待确认，否则宁可放行，
  // 避免一次接口抖动把整条时间线都盖掉。
  if (signals.degraded) return set(score >= 2 ? BAND.review : BAND.ignore, [signals.degraded]);

  /* ---------------- 5) 放行 ---------------- */
  if (!enabled && hideable && confidence >= T.hideConfidence) {
    // 类别被用户关掉：明确说明为什么放行，便于排查
    return set(BAND.ignore, ['category_disabled']);
  }
  return set(BAND.ignore, []);
}

/**
 * 动作规划：把「判定」翻译成「要不要真的点静音/拉黑」。
 * 破坏性动作受四重约束：判定带必须是 block、必须已关闭演练、必须还有预算、作者必须可识别。
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

export { CATEGORY };
