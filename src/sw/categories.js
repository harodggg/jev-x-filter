/**
 * 过滤类别：整个项目唯一的「类别事实表」。
 *
 * 为什么要单独一个文件：类别名同时出现在 **JEV 的问题选项 / 闸门策略 / 设置页开关 /
 * 过滤条文案 / 统计 / 审计日志** 六处，散着写必然漂移。这里集中定义，其它模块只读。
 *
 * 设计约定
 * - `accountEligible`：该类别**最多**能走到 `block` 档（可执行静音/拉黑）。
 *   对勾「可动账号」的只有色情、诈骗、广告导流三类 —— 标题党、低质、擦边诱饵永远只隐藏。
 * - `hideable`：该类别允许被隐藏（`ordinary` / `other` / 未知类别不隐藏）。
 * - `group`：设置页的开关粒度。色情内容与色情引流共用一个开关。
 * - `farm` 不是模型类别，而是**结构信号**（同一段文案被多个账号刷屏），单独一组开关。
 */

export const CATEGORY = {
  adultPorn: 'adult_porn',
  adultSolicitation: 'adult_solicitation',
  scam: 'scam',
  adSpam: 'ad_spam',
  clickbait: 'clickbait',
  lowQuality: 'low_quality',
  suggestiveBait: 'suggestive_bait',
  ordinary: 'ordinary',
  other: 'other',
};

/** JEV choice 问题的选项（顺序即给模型看的顺序；description 用英文，模型在英文上最稳）。 */
export const CATEGORY_CRITERIA = {
  [CATEGORY.adultPorn]: 'Explicit sexual or pornographic material, or direct promotion of it',
  [CATEGORY.adultSolicitation]: 'Adult sexual solicitation, escort or paid sexual services, selling explicit content',
  [CATEGORY.scam]:
    'Fraud, financial scam or illegal gambling: guaranteed returns, insider tips, pump-and-dump, pig-butchering romance scam, fake investment platforms, betting/casino promotion, fake job or loan traps',
  [CATEGORY.adSpam]:
    'Commercial spam or traffic diversion: ad, affiliate or dropshipping promotion, "DM me", "link in bio", group/WeChat/Telegram recruitment, selling followers or engagement',
  [CATEGORY.clickbait]:
    'Engagement bait, outrage bait or a deceptive headline: "you will not believe", "share before it is deleted", missing context used to provoke, fake urgency',
  [CATEGORY.lowQuality]:
    'Low-information filler: machine-generated slop, rewritten or copied content with no added information, empty platitudes, keyword stuffing',
  [CATEGORY.suggestiveBait]:
    'Sexually suggestive but not explicit, or a tease/bait post whose purpose is to get the reader to open the profile or follow',
  [CATEGORY.ordinary]: 'Normal content: personal, news, business, hobby, political or educational posts without solicitation',
  [CATEGORY.other]: null,
};

export const CATEGORY_META = {
  [CATEGORY.adultPorn]: {
    label: '色情内容',
    group: 'adult',
    hideable: true,
    accountEligible: true,
    barLabel: '色情内容',
  },
  [CATEGORY.adultSolicitation]: {
    label: '色情/性交易引流',
    group: 'adult',
    hideable: true,
    accountEligible: true,
    barLabel: '色情引流',
  },
  [CATEGORY.scam]: {
    label: '诈骗/博彩/荐股',
    group: 'scam',
    hideable: true,
    accountEligible: true,
    barLabel: '疑似诈骗',
  },
  [CATEGORY.adSpam]: {
    label: '广告/导流/带货',
    group: 'ad_spam',
    hideable: true,
    accountEligible: true,
    barLabel: '广告导流',
  },
  [CATEGORY.clickbait]: {
    label: '标题党/情绪煽动',
    group: 'clickbait',
    hideable: true,
    accountEligible: false,
    barLabel: '标题党',
  },
  [CATEGORY.lowQuality]: {
    label: '低质 AI/洗稿/无信息量',
    group: 'low_quality',
    hideable: true,
    accountEligible: false,
    barLabel: '低质内容',
  },
  [CATEGORY.suggestiveBait]: {
    label: '擦边/诱饵贴',
    group: 'adult',
    hideable: true,
    accountEligible: false,
    barLabel: '擦边诱饵',
  },
  [CATEGORY.ordinary]: { label: '普通内容', group: null, hideable: false, accountEligible: false, barLabel: '' },
  [CATEGORY.other]: { label: '无法归类', group: null, hideable: false, accountEligible: false, barLabel: '' },
};

/** 设置页的开关分组（`farm` 是结构信号，不在模型类别里）。 */
export const CATEGORY_GROUPS = {
  adult: { label: '色情 / 性交易引流', hint: '含色情内容、性交易引流与擦边诱饵贴' },
  scam: { label: '诈骗 / 博彩 / 荐股', hint: '承诺收益、内幕消息、杀猪盘、赌博平台' },
  ad_spam: { label: '广告 / 导流 / 带货', hint: '点主页、加微信、私信我、招商代理' },
  clickbait: { label: '标题党 / 情绪煽动', hint: '不看后悔、删前速看、断章取义引战' },
  low_quality: { label: '低质 AI / 洗稿 / 无信息量', hint: '车轱辘话、洗稿拼接、关键词堆砌' },
  farm: { label: '刷屏 / 重复文案 / 机器人农场', hint: '同一段文案被多个账号短时间复制' },
};

/** 类别的开关分组名；未知类别返回 null（= 不隐藏、不动作）。 */
export function groupForCategory(category) {
  return CATEGORY_META[category]?.group ?? null;
}

export function categoryLabel(category) {
  return CATEGORY_META[category]?.label ?? String(category ?? '');
}

/** 该类别是否被用户打开（未知类别一律视为关闭 → 放行，宁可漏杀不可误杀）。 */
export function isCategoryEnabled(category, settings) {
  const group = groupForCategory(category);
  if (!group) return false;
  return settings?.categories?.[group]?.enabled !== false;
}

export function isHideable(category) {
  return Boolean(CATEGORY_META[category]?.hideable);
}

/** 该类别**最多**能否触发账号动作（真正的动作还要过闸门与演练/预算）。 */
export function isAccountEligible(category) {
  return Boolean(CATEGORY_META[category]?.accountEligible);
}

/** 把模型返回的类别收敛到已知取值；未知/缺失一律当 `other`（安全侧）。 */
export function normalizeCategory(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return Object.prototype.hasOwnProperty.call(CATEGORY_META, value) ? value : CATEGORY.other;
}

/** 供统计与 UI 用的类别顺序。 */
export const CATEGORY_ORDER = [
  CATEGORY.adultPorn,
  CATEGORY.adultSolicitation,
  CATEGORY.suggestiveBait,
  CATEGORY.scam,
  CATEGORY.adSpam,
  CATEGORY.clickbait,
  CATEGORY.lowQuality,
  CATEGORY.ordinary,
  CATEGORY.other,
];
