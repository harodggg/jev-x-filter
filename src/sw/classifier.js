/**
 * 把一条推文翻译成 Jev 的「类型化问题」。
 *
 * 三条硬性约束（来自 jev-systemone 的类型定义）：
 * - `state` 只能是文本；Jev 不是对话模型，它只回答 choice / score / noul；
 * - choice 最多 255 个选项，score 只能 2–10 级；
 * - question id 不会发送给模型，所以完整问题必须写在 instructions 里，而且要用英文
 *   （上游文档明确说明：模型在英文上最稳）。
 */
import { choice, noul, score } from '../vendor/jev-systemone/dist/index.js';
import { truncate } from './util.js';

export const QID = {
  adult: 'adult',
  solicitation: 'solicitation',
  category: 'category',
  severity: 'severity',
  /** 预检专用：只问一句，用来给「没被关键词命中」的推文做廉价召回。 */
  bait: 'bait',
};

/**
 * 预检问题（单问，成本约为完整四问的 1/4）。
 *
 * 措辞来自真实模型实测：这版描述在「骚式自夸 + 乱码账号名」样本上给 0.80，
 * 而普通日常 0.02 / 正常小性感 0.13 / 健身自拍 0.04，分离度足够。
 * 关键是它问的是**原型**（机器人式成人诱饵），而不是「有没有色情词」——
 * 这正是通用性的来源：不需要把「骚」这类词穷举进词表。
 */
export const BAIT_INSTRUCTIONS =
  'This post looks like bot-driven adult-content bait: the text is a sexually suggestive brag or tease with little or no real information, ' +
  'and/or the account name looks like random gibberish, in a way whose purpose is to get the reader to open the profile or follow. ' +
  'Ordinary flirting, jokes, fashion, fitness, relationship talk and news do NOT count.';

export function buildBaitProbe() {
  return { [QID.bait]: noul(BAIT_INSTRUCTIONS) };
}

/** 预检答案 → 概率（缺字段返回 null，绝不猜）。 */
export function readBaitAnswer(answers) {
  const raw = answers?.[QID.bait]?.noul;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw));
}

export const CATEGORY = {
  adultPorn: 'adult_porn',
  adultSolicitation: 'adult_solicitation',
  suggestive: 'suggestive',
  ordinary: 'ordinary',
  other: 'other',
};

/** 只有这两类才允许进入「可拉黑」的强判定。 */
export const STRONG_CATEGORIES = [CATEGORY.adultPorn, CATEGORY.adultSolicitation];
export const BORDERLINE_CATEGORIES = [CATEGORY.suggestive];

const STATE_LIMIT = 4000;

/**
 * 渲染一条推文为 state 文本。刻意保留原文（不翻译），
 * 只在外面包一层英文元数据，避免翻译过程丢线索。
 */
export function buildState(tweet) {
  const media = Array.isArray(tweet?.media) ? tweet.media : [];
  const lines = [
    'POST TEXT:',
    String(tweet?.text ?? '').trim() || '(no text)',
    '',
    'AUTHOR:',
    `handle=@${String(tweet?.handle ?? '').replace(/^@+/, '') || 'unknown'}`,
  ];
  if (tweet?.displayName) {
    // 真实黄推的常见套路：正文写得无害，全部引流信息塞进显示名。所以显示名单独占一行。
    lines.push(`display_name=${truncate(tweet.displayName, 120)}`);
  }
  lines.push(
    '',
    'CONTEXT:',
    `position=${tweet?.context ?? 'timeline'}; has_media=${media.length > 0 ? 'yes' : 'no'}; media_count=${media.length}`,
  );
  if (tweet?.altText) lines.push(`media_alt_text=${truncate(tweet.altText, 300)}`);
  if (tweet?.cardText) lines.push(`link_card_text=${truncate(tweet.cardText, 300)}`);
  if (tweet?.quotedText) lines.push(`quoted_post_text=${truncate(tweet.quotedText, 300)}`);
  if (tweet?.lang) lines.push(`declared_language=${tweet.lang}`);
  if (typeof tweet?.mediaSkinRatio === 'number') {
    lines.push(`local_image_skin_tone_ratio=${tweet.mediaSkinRatio.toFixed(3)}`);
  }
  if (typeof tweet?.visionAdultProb === 'number') {
    lines.push(`local_vision_adult_probability=${tweet.visionAdultProb.toFixed(3)}`);
  }
  return truncate(lines.join('\n'), STATE_LIMIT);
}

/**
 * 四个问题一起问（服务端并行执行，互不影响）：
 * adult / solicitation 负责「要不要管」，category 负责「管多严 + 置信度」，
 * severity 记录程度，便于事后调阈值。
 */
export function buildQuestions() {
  return {
    [QID.adult]: noul(
      'The visible content of this post is sexual or pornographic material, OR it is an adult sexual solicitation aimed at the reader. ' +
        'Treat the AUTHOR display_name as part of the visible content: spam accounts often keep the post text harmless and put the ' +
        'sexual solicitation in the display name (for example "真实同城约p", "主页联系", "🔞免费"). ' +
        'News, education, activism, moderation announcements, public-safety warnings and academic discussion ABOUT adult content do NOT count as adult content. ' +
        'Judge the post as posted, including whether the attached media is described as explicit.',
      {
        true: 'sexually explicit media, pornographic promotion, or a direct adult sexual solicitation',
        false: 'ordinary content, or content that only talks about adult topics without soliciting or showing them',
      },
    ),
    [QID.solicitation]: noul(
      'The post asks the reader to move to a private or off-platform channel (Telegram, WeChat, WhatsApp, Snapchat, an external link, the profile page or a DM) ' +
        'in order to buy, watch or receive sexual content or sexual services. The author display_name counts as part of the post.',
    ),
    [QID.category]: choice(
      'Which single category best describes this post? Choose the most specific one; use "ordinary" for normal personal, news, business, hobby or political content, and "other" when none of the listed categories fits.',
      {
        [CATEGORY.adultPorn]: 'Explicit sexual or pornographic content, or direct promotion of it',
        [CATEGORY.adultSolicitation]: 'Adult sexual solicitation / escort / paid sexual services / selling explicit content',
        [CATEGORY.suggestive]: 'Suggestive or risqué but not explicit, and not a sexual solicitation',
        [CATEGORY.ordinary]: 'Normal content with no sexual solicitation',
        [CATEGORY.other]: null,
      },
    ),
    [QID.severity]: score(
      'How explicit or commercial is the sexual content of this post? Rate the situation, not a vague degree.',
      [
        'No sexual content, or only a passing mention',
        'Suggestive wording or imagery without explicit content',
        'Clearly sexual content or a soft sexual solicitation',
        'Explicit pornography or a hard paid-sexual-services solicitation',
      ],
    ),
  };
}

export function buildRequest(tweet) {
  return { state: buildState(tweet), questions: buildQuestions() };
}

/** 把模型的答案读成稳定的数值视图，缺字段一律当作「不确定」。 */
export function readAnswers(answers) {
  const a = answers ?? {};
  const adultRaw = a[QID.adult];
  const solRaw = a[QID.solicitation];
  const catRaw = a[QID.category];
  const sevRaw = a[QID.severity];
  const category = typeof catRaw?.choice === 'string' ? catRaw.choice : 'other';
  return {
    adult: typeof adultRaw?.noul === 'number' ? clamp01(adultRaw.noul) : 0,
    solicitation: typeof solRaw?.noul === 'number' ? clamp01(solRaw.noul) : 0,
    category,
    categoryProbabilities: catRaw?.probabilities ?? null,
    categoryConfidence: typeof catRaw?.confidence === 'number' ? clamp01(catRaw.confidence) : 0,
    severity: typeof sevRaw?.score === 'number' ? sevRaw.score : 0,
    severityConfidence: typeof sevRaw?.confidence === 'number' ? clamp01(sevRaw.confidence) : 0,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
