/**
 * 把一条推文翻译成 Jev 的「类型化问题」。
 *
 * 三条硬性约束（来自 jev-systemone 的类型定义）：
 * - `state` 只能是文本；Jev 不是对话模型，它只回答 choice / score / noul；
 * - choice 最多 255 个选项，score 只能 2–10 级；
 * - question id 不会发送给模型，所以完整问题必须写在 instructions 里，而且要用英文
 *   （上游文档明确说明：模型在英文上最稳）。
 *
 * v0.3.0 起这是**信息过滤器**：类别由 `categories.js` 单点定义（色情、诈骗、广告导流、
 * 标题党、低质内容、擦边诱饵），不再只问「是不是色情」。
 */
import { choice, noul, score } from '../vendor/jev-systemone/dist/index.js';
import { CATEGORY, CATEGORY_CRITERIA, normalizeCategory } from './categories.js';
import { truncate } from './util.js';

export const QID = {
  /** 色情精确判定（保留，用于「可动账号」的高置信度路径）。 */
  adult: 'adult',
  /** 是否把人往站外/私域渠道引（广告与色情引流共用）。 */
  solicitation: 'solicitation',
  /** 是否具有欺骗性/诱导性（承诺收益、假冒身份、夸大疗效、诱导点击或转账）。 */
  deceptive: 'deceptive',
  /** 类别：多选一（含普通内容与「都无法归类」），带置信度。 */
  category: 'category',
  /** 危害/干扰程度：四级。 */
  severity: 'severity',
  /** 预检专用单问（未命中关键词的推文的廉价召回）。 */
  junk: 'junk',
};

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
    // 真实垃圾账号的常见套路：正文写得无害，全部引流信息塞进显示名。所以显示名单独占一行。
    lines.push(`display_name=${truncate(tweet.displayName, 120)}`);
  }
  lines.push(
    '',
    'CONTEXT:',
    `platform=x.com; position=${tweet?.context ?? 'timeline'}; has_media=${media.length > 0 ? 'yes' : 'no'}; media_count=${media.length}`,
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
 * 五个问题一起问（服务端并行执行，互不影响）：
 * category 是主干（属于哪一类、信不信得过），adult / solicitation / deceptive 是三条
 * 独立的「硬度」证据，severity 记录程度。
 */
export function buildQuestions() {
  return {
    [QID.category]: choice(
      'Which single category best describes this post? Choose the most specific one. Use "ordinary" for normal content with no promotion, fraud or bait, and "other" only when none of the listed categories fits.',
      CATEGORY_CRITERIA,
    ),
    [QID.adult]: noul(
      'The visible content of this post is sexual or pornographic material, OR it is an adult sexual solicitation aimed at the reader. ' +
        'Treat the AUTHOR display_name as part of the visible content: spam accounts often keep the post text harmless and put the ' +
        'sexual solicitation in the display name (for example "真实同城约p", "主页联系", "🔞免费"). ' +
        'News, education, activism, moderation announcements, public-safety warnings and academic discussion ABOUT adult content do NOT count as adult content.',
      {
        true: 'sexually explicit media, pornographic promotion, or a direct adult sexual solicitation',
        false: 'ordinary content, or content that only talks about adult topics without soliciting or showing them',
      },
    ),
    [QID.solicitation]: noul(
      'The post asks the reader to move to a private or off-platform channel (Telegram, WeChat, WhatsApp, Snapchat, an external link, the profile page or a DM) ' +
        'in order to buy, receive or join something — sexual content or services, a paid group, a product, an investment or a gambling channel. ' +
        'The author display_name counts as part of the post.',
    ),
    [QID.deceptive]: noul(
      'The post is deceptive or manipulative in a way that can cause real harm: promising guaranteed or unrealistic returns, insider stock/crypto tips, ' +
        'fake investment or trading platforms, illegal gambling or betting promotion, pig-butchering romance or job scams, fake giveaways, ' +
        'impersonation, fabricated quotes, out-of-context claims presented as fact, or fake urgency designed to force a click, a payment or a share. ' +
        'Honest opinions, satire, ordinary advertising and legitimate news do NOT count.',
    ),
    [QID.severity]: score(
      'How harmful or disruptive is this post for a reader scrolling their timeline? Rate the situation, not a vague degree.',
      [
        'No harm: normal content, or a passing mention with no promotion or bait',
        'Mildly disruptive: ordinary advertising, mild clickbait, low-information filler',
        'Clearly harmful or deceptive: explicit solicitation, fraud bait, fabricated claims, hard engagement bait',
        'Severely harmful: financial fraud, illegal gambling, explicit pornography, sexual solicitation of a minor or non-consensual content',
      ],
    ),
  };
}

/**
 * 预检问题（单问，成本约为完整五问的 1/5）。
 *
 * 关键词表永远只是「廉价的怀疑」，不是召回上限：没被词表命中的推文也要让模型看一眼。
 * 措辞问的是**原型**（垃圾/诈骗/诱饵/机器人填充），而不是「有没有某个词」——
 * 这是通用性的来源。
 */
export const JUNK_INSTRUCTIONS =
  'This post looks like timeline junk rather than something a real person wrote to inform or discuss: ' +
  'spam advertising or traffic diversion, a scam or fraud bait (guaranteed returns, gambling, fake giveaways), ' +
  'engagement bait or an outrage/deceptive headline, a sexually suggestive tease, or machine-generated filler with no real information. ' +
  'Also treat it as junk when the account name looks like random gibberish and the text is a generic greeting or tease whose only purpose ' +
  'is to get the reader to open the profile or follow. ' +
  'Ordinary opinions, jokes, news, education, hobby, fitness, fashion and relationship talk do NOT count.';

export function buildJunkProbe() {
  return { [QID.junk]: noul(JUNK_INSTRUCTIONS) };
}

export function buildRequest(tweet) {
  return { state: buildState(tweet), questions: buildQuestions() };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 把模型的答案读成稳定的数值视图，缺字段一律当作「不确定」。 */
export function readAnswers(answers) {
  const a = answers ?? {};
  const adultRaw = a[QID.adult];
  const solRaw = a[QID.solicitation];
  const decRaw = a[QID.deceptive];
  const catRaw = a[QID.category];
  const sevRaw = a[QID.severity];
  return {
    adult: typeof adultRaw?.noul === 'number' ? clamp01(adultRaw.noul) : 0,
    solicitation: typeof solRaw?.noul === 'number' ? clamp01(solRaw.noul) : 0,
    deceptive: typeof decRaw?.noul === 'number' ? clamp01(decRaw.noul) : 0,
    category: normalizeCategory(catRaw?.choice),
    categoryProbabilities: catRaw?.probabilities ?? null,
    categoryConfidence: typeof catRaw?.confidence === 'number' ? clamp01(catRaw.confidence) : 0,
    severity: typeof sevRaw?.score === 'number' ? sevRaw.score : 0,
    severityConfidence: typeof sevRaw?.confidence === 'number' ? clamp01(sevRaw.confidence) : 0,
  };
}

/** 预检答案 → 概率（缺字段返回 null，绝不猜）。 */
export function readJunkAnswer(answers) {
  const raw = answers?.[QID.junk]?.noul;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return clamp01(raw);
}

export { CATEGORY };
