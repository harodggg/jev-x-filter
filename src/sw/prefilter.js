/**
 * 预筛（完全本地、确定性、零成本）。
 *
 * 目的不是判定，而是「决定要不要花一次 Jev 调用」：
 * 1. 命中强特征（同城约p/福利姬/主页联系/onlyfans/escort…）→ 送模型；
 * 2. 只发图、文案极短、纯链接的黄推 → 由 media 流程处理；
 * 3. 白名单、超短无媒体、超出 scope 的推文 → 直接跳过，一次请求都不发。
 *
 * ⚠ 真实踩坑（2026-09 真站样本）：黄推把**全部引流信息写在「显示名」里**
 *   （`🍑真实同城约p🍑主页联系🔞免费`），正文故意写成无害的「那一夜你没有拒绝我😭🤣不是人机」。
 *   早期版本只扫正文，于是它连候选都不是 —— 一次模型调用都不会发生，直接放行。
 *   现在显示名/卡片文案/图片 alt 与正文一起进预筛（显示名单独计分，见 nameHits）。
 *
 * 这里所有规则都是可读正则，误判可回溯；模型只做「二次确认 + 置信度」，
 * 因此预筛宁可多送一次调用，也不做「只有预筛命中才隐藏」这种廉价结论。
 */

/** 强特征：色情引流/交易的黑话与站外联系方式。`sexual` 标记「本身即色情/性交易」的规则。 */
export const STRONG_RULES = [
  {
    id: 'zh_solicit_jiaofu',
    label: '约啪/约p/同城上门/附近约',
    sexual: true,
    // 含拉丁字母变体（约p / 约P）与「同城 + 联系」这类绕过写法
    pattern: /约\s*[啪炮pP]|同城(?:上门|服务|约|联系|资源|外围|妹)|上门服务|空降|楼凤|外围|找小姐|包养|援交|一夜情|少妇|探花|口爆|毒龙|附近(?:约|人)/,
  },
  {
    id: 'zh_profile_contact',
    label: '引导看主页/简介联系',
    // 「链接在简介」正常创作者也会写，所以不算「本身即色情」
    sexual: false,
    // 「主页匹配 / 无套路匹配 / 主页联系」是同一批农场账号的固定话术（真站样本）
    pattern: /(?:主页|简介|资料|置顶|签名)(?:有|里|看|联系|加|扫|取|匹配|约|交友|服务|群|通道|领)|无套路|(?:看|点|进|移步)\s*(?:我)?(?:的)?(?:主页|简介|资料|置顶)/,
  },
  {
    id: 'zh_premium_content',
    label: '福利姬/资源/裸聊',
    sexual: true,
    pattern: /福利姬|裸聊|视频裸|涩涩|看片|成人(?:视频|网站|内容|影片)|色情(?:视频|网站|直播)|黄片|激情(?:视频|直播)|小视频|车牌号|资源群|付费群|福利(?:视频|资源|群)/,
  },
  {
    id: 'zh_contact',
    label: '加微信/电报引流',
    sexual: false,
    pattern: /加\s*(?:微信|vx|v信|q|qq|电报|纸飞机)|私(?:聊|信)\s*我|t\.me\/|telegram|电报群|扫码(?:进群|加)|vx[：:\s]*[a-z0-9_-]{4,}/i,
  },
  {
    id: 'en_nsfw',
    label: 'NSFW/porn/onlyfans',
    sexual: true,
    pattern: /\b(?:nsfw|porn(?:o|hub)?|xxx|onlyfans|of\s*link|camgirl|nudes?|naked|sex(?:cam|chat|tape)|adult\s*content|hardcore|hentai|escort|sugar\s*(?:daddy|baby)|hookup|sexting)\b/i,
  },
  {
    id: 'en_dm_menu',
    label: 'DM for menu/off-platform 引流',
    sexual: false,
    pattern: /dm\s*(?:me\s*)?for\s*(?:menu|price|details)|\bselling\s*(?:content|pics|vids)\b|\bsnap(?:chat)?\s*(?:premium|menu)\b|\btext\s*me\s*(?:for|now)\b|\bmenu\s*in\s*bio\b/i,
  },
];

/** 弱特征：单独出现不足以送模型，需要累积或与媒体信号组合。 */
export const WEAK_RULES = [
  { id: 'zh_weak_resource', label: '资源/福利/免费看', pattern: /资源|福利|免费看|免费领|私密|真人|在线看|激情|情色|成人/ },
  { id: 'zh_weak_teen', label: '学生妹/极品/网红', pattern: /学生妹|极品|网红|空姐|护士|模特/ },
  { id: 'zh_anti_bot', label: '反检测话术（不是人机/真人可约）', pattern: /不是人机|非机器人|真人可约|真人服务|不是机器人|本人(?:在线|可约)|不是ai/ },
  { id: 'emoji_adult', label: '🔞 成人标记', pattern: /🔞/ },
  { id: 'en_weak_18', label: '18+/explicit 暗示', pattern: /\b18\+|explicit|\buncensored\b|\bfull\s*video\b|\bprivate\s*show\b/i },
];

/** 新闻/科普/治理语境：把强特征降级，避免误杀“警方通报打击色情信息”这类正常内容。 */
export const NEWS_CONTEXT = /警方|通报|法院|判决|起诉|整治|治理|专项行动|打击|查处|净网|未成年|举报|宣传|教育部|法规|律师|研究|报告|新闻|转载|辟谣|受害者|防范|警示/;

/**
 * 乱码账号名启发式：`yrmyzhcxvlkzpu` / `cxvlu` 这类随机串是黄推账号网络的常见特征
 * （两张真站截图都是这种名字）。判断只用**结构**，不用词表：
 * 拉丁字母 ≥5 个、不含分隔符、元音比例 < 0.22 或存在 ≥4 的连续辅音串。
 * 它只算一条弱特征（+1），单独绝不足以隐藏 —— 避免误伤「随机但正常」的用户名。
 * y 记作元音，免得把 system/mytype 这种拼写判成乱码。
 */
export function looksRandomName(handle, displayName) {
  const sources = [String(handle ?? ''), String(displayName ?? '')].filter(Boolean);
  for (const source of sources) {
    if (/[\s_\-.]/.test(source)) continue;
    const letters = source.toLowerCase().replace(/[^a-z]/g, '');
    const digits = source.replace(/[^0-9]/g, '');
    if (letters.length < 5 || digits.length > 6) continue;
    const vowels = (letters.match(/[aeiouy]/g) ?? []).length;
    const ratio = vowels / letters.length;
    const longestRun = Math.max(0, ...(letters.split(/[aeiouy]+/).map((part) => part.length)));
    if (ratio < 0.22 || longestRun >= 5) return { random: true, source, vowelRatio: Number(ratio.toFixed(3)), longestRun };
  }
  return { random: false, source: null, vowelRatio: null, longestRun: 0 };
}

/** 纯转推/纯链接、没有实质文案的形态。 */
export const LINK_ONLY = /^(?:https?:\/\/\S+\s*)+$/;

/** NFKC + 小写 + 去零宽字符 + 压缩空白：让“约 啪”“𝐎𝐧𝐥𝐲𝐅𝐚𝐧𝐬”这类变体也能命中。 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function testRule(rule, text) {
  rule.pattern.lastIndex = 0;
  return rule.pattern.test(text);
}

/**
 * 匹配规则。返回命中列表；newsContext 为真时强特征权重降为 1。
 */
export function matchRules(text, { rules = STRONG_RULES, weight = 3, newsContext = false } = {}) {
  const hits = [];
  if (!text) return hits;
  for (const rule of rules) {
    if (testRule(rule, text)) {
      hits.push({
        id: rule.id,
        label: rule.label,
        sexual: Boolean(rule.sexual),
        weight: newsContext && weight >= 3 ? 1 : weight,
      });
    }
  }
  return hits;
}

/**
 * @param {object} tweet 归一化后的推文（见 src/content/extract.js）
 * @param {object} settings normalizeSettings() 的结果
 */
export function preScreen(tweet, settings) {
  const text = normalizeText(tweet?.text ?? '');
  const nameText = normalizeText(tweet?.displayName ?? '');
  const extraText = normalizeText([tweet?.cardText, tweet?.altText].filter(Boolean).join(' '));
  const hasMedia = Boolean(tweet?.media?.length) || Boolean(tweet?.hasMedia);
  const context = tweet?.context ?? 'timeline';

  const randomNameInfo = looksRandomName(tweet?.handle, tweet?.displayName);
  const result = {
    candidate: false,
    score: 0,
    reasons: [],
    nameReasons: [],
    strongNameHit: false,
    randomName: randomNameInfo.random,
    skip: null,
    newsContext: false,
    shortWithMedia: false,
  };

  if (tweet?.isOwn) {
    result.skip = 'own_tweet';
    return result;
  }
  if (!tweet?.handle && !nameText && !text && !hasMedia) {
    result.skip = 'no_author';
    return result;
  }
  const handle = String(tweet?.handle ?? '').replace(/^@+/, '').toLowerCase();
  if (handle && settings?.whitelist?.handles?.includes(handle)) {
    result.skip = 'whitelisted_handle';
    return result;
  }
  if (context === 'reply' && settings?.scope?.replies === false) {
    result.skip = 'scope_replies_off';
    return result;
  }
  if (context === 'recommended' && settings?.scope?.recommended === false) {
    result.skip = 'scope_recommended_off';
    return result;
  }
  if (context === 'timeline' && settings?.scope?.timeline === false) {
    result.skip = 'scope_timeline_off';
    return result;
  }

  // 新闻语境只看正文：账号名里写「警方」不该把名字上的垃圾特征洗白。
  result.newsContext = NEWS_CONTEXT.test(text);

  const nameHits = matchRules(nameText, { rules: STRONG_RULES, weight: 3, newsContext: false });
  const bodyHits = matchRules(text, { rules: STRONG_RULES, weight: 3, newsContext: result.newsContext });
  const extraHits = matchRules(extraText, { rules: STRONG_RULES, weight: 3, newsContext: false });
  const weakHits = [
    ...matchRules([nameText, extraText, text].filter(Boolean).join(' \n '), { rules: WEAK_RULES, weight: 1 }),
    ...(randomNameInfo.random ? [{ id: 'random_name', label: '账号名疑似随机串（机器人特征）', sexual: false, weight: 1 }] : []),
  ];
  const strongHits = [...nameHits, ...bodyHits, ...extraHits];

  result.nameReasons = [...new Set(nameHits.map((h) => h.id))];
  result.strongNameHit = nameHits.some((h) => h.sexual);

  const minLen = settings?.scope?.minTextLength ?? 4;
  // 正文极短、但「显示名本身就是色情引流」的账号照样要送模型。
  if (text.length < minLen && !hasMedia && !result.strongNameHit) {
    result.skip = 'too_short_no_media';
    return result;
  }

  const customKeywords = settings?.whitelist?.keywords ?? [];
  if (customKeywords.length > 0) {
    const haystackLower = [nameText, text].join(' ').toLowerCase();
    const hit = customKeywords.find((k) => k && haystackLower.includes(String(k).toLowerCase()));
    if (hit) {
      result.skip = `whitelisted_keyword:${hit}`;
      return result;
    }
  }

  const hits = [...strongHits, ...weakHits];
  result.reasons = [...new Set(hits.map((h) => h.id))];
  result.score = hits.reduce((sum, h) => sum + h.weight, 0);

  // 只发图/纯链接：交给媒体分析（文案几乎没有信息量）。
  result.shortWithMedia = hasMedia && (text.length < 20 || LINK_ONLY.test(text));
  if (result.shortWithMedia) result.reasons.push('short_text_with_media');

  // 阈值 2：一条强特征（3）或两条弱特征命中即送模型。
  result.candidate = result.score >= 2 || strongHits.length > 0;

  if (hasMedia && !result.candidate) result.reasons.push('has_media_weak_text');

  return result;
}

/** 供 UI 展示：把规则 id 变回中文标签。 */
export const RULE_LABELS = {
  ...Object.fromEntries([...STRONG_RULES, ...WEAK_RULES].map((r) => [r.id, r.label])),
  random_name: '账号名疑似随机串（机器人特征）',
  short_text_with_media: '纯图片/纯链接形态',
  has_media_weak_text: '有媒体但文案无特征',
};

export function describeReasons(reasons = []) {
  return reasons.map((r) => RULE_LABELS[r] ?? r);
}
