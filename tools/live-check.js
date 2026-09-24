/**
 * 真实模型验证（可选，需要你自己的 Jev Key）。
 *
 * 单元测试与端到端测试都打 mock 网关（验证协议与流程）；这个脚本打**真实** Jev，
 * 而且直接跑**扩展真正使用的那套流水线**（`createPipeline`：预筛 → 图片信号 → 预检/四问
 * → 闸门 → 动作规划），所以它验证的是「包括模型先行预检在内的真实判定行为」，
 * 而不是另写一份可能与线上不一致的逻辑。
 *
 * 检查三件事：
 *   1. 黄推（含只把引流写在显示名、或完全不含关键词的「骚式自夸」）能不能被拦下来；
 *   2. 日常 / 治理新闻 / 性教育科普 / 泳装擦边 / 正常小性感**绝不能**被隐藏或拉黑（安全底线）；
 *   3. 真实延迟与 token 用量（评估预检与每日预算）。
 *
 * Key 只从环境变量读取，绝不会写进任何文件：
 *
 *   JEV_API_KEY=xxx JEV_PRESET=typesafe node tools/live-check.js
 *   JEV_API_KEY=xxx JEV_PRESET=zen JEV_MODEL=jev-1.13-free node tools/live-check.js
 */
import fs from 'node:fs';
import { JevClient } from '../src/vendor/jev-systemone/dist/index.js';
import { createAuditor } from '../src/sw/audit.js';
import { createPipeline } from '../src/sw/pipeline.js';
import { normalizeSettings, resolveApi } from '../src/sw/settings.js';

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '';
const preset = process.env.JEV_PRESET || 'typesafe';
const modelOverride = process.env.JEV_MODEL || '';

if (!apiKey && preset !== 'zen') {
  console.error('缺少 Key。用法：JEV_API_KEY=xxx node tools/live-check.js');
  process.exit(2);
}

const settings = normalizeSettings({
  api: { preset, apiKey, model: modelOverride },
  // 只做「判定」，账号动作全部停在演练档，绝不碰任何账号。
  action: { dryRun: true, autoMute: true, autoBlock: false },
  scope: { onlyVisible: false },
  // 真机验证会被 30+ 条样本连续调用，而预检/判定/语义层**共用同一个每分钟 Jev 额度**：
  // 不放大就会出现「后面的 α/β 样本因为前面把分钟额度打满而整层跳过」——那不是模型的问题。
  // 数值必须落在 settings.js 的夹紧区间内（≤600/分钟），否则会被夹回去。
  budget: { maxJevPerMinute: 600, maxJevPerDay: 5000 },
  triage: { enabled: true, sampleRate: 1, maxPerMinute: 600, maxPerDay: 5000 },
  semantics: {
    enabled: true,
    beta: { enabled: true, threshold: 0.7, maxCandidates: 6, windowSize: 60, foldInFeed: true, foldInReplies: true },
    alpha: { enabled: true, onlyInReplies: true, threshold: 0.7, minReferences: 3, maxReferences: 12 },
    maxPerMinute: 600,
    maxPerDay: 5000,
  },
});
const api = resolveApi(settings);

const client = new JevClient({
  preset: api.preset === 'zen' ? 'zen' : 'custom',
  baseURL: api.baseURL,
  path: api.path,
  apiKey: api.apiKey || undefined,
  defaultModel: api.model,
  timeout: 45000,
  retry: { maxRetries: 1 },
  dangerouslyAllowBrowser: true,
});

/** 记录每次真实调用（问了什么、答了什么），用于报告。 */
const calls = [];
const jev = {
  async systemOne(request, options) {
    const response = await client.systemOne(request, options);
    calls.push({ request, response });
    return response;
  },
};

/** 流水线要的图片信号：按样本给的肤色占比构造一帧统计，交给真实的 mediaSuspicion 判定。 */
let currentSkinRatio = null;
const analyzeImage = async () => {
  if (currentSkinRatio === null) return { ok: false, error: 'no_media' };
  return {
    ok: true,
    stats: {
      pixels: 4096,
      skinRatio: currentSkinRatio,
      maxCellRatio: currentSkinRatio,
      dominantCells: currentSkinRatio >= 0.6 ? 16 : 4,
      cells: 16,
      flatRatio: 0.2,
      texture: 0.12,
    },
  };
};

const pipeline = createPipeline({
  getSettings: () => settings,
  jev,
  analyzeImage,
  classifyWithVision: null,
  auditor: createAuditor({ version: 'live-check' }),
  random: () => 0.5, // sampleRate=1 时行为确定
  onActionCandidate: () => {},
});

/**
 * 样本期望：
 *   mustNotHide —— 明确不是黄推：既不能隐藏、更不能 block（安全底线，失败即退出码 1）
 *   mustNotBlock —— 可能擦边：可以隐藏，但绝不能 block（安全底线）
 *   expectHidden —— 垃圾信息形态：至少要被隐藏（质量期望，未达只告警）
 *   expectBlock  —— 期望进入 block 档（可动账号；未达只告警）
 *   expectHideOnly —— 期望隐藏但**绝不**进入 block 档（误进 block 记硬失败）
 *   knownGap    —— 已知残差：只记录、不计入成败（例如单条孤立样本模型自己判「普通」）
 *   expectBetaFolded —— 期望被判为 β（β.folded === true）
 *   expectAlphaHit   —— 期望被判为 α（alpha.hit === true）
 */
const SAMPLES = [
  {
    name: '中文黄推引流',
    tweet: { id: 's1', handle: 'spam1', text: '同城约啪 加电报 t.me/demo 少妇上门 视频福利', media: [], context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '英文 escort',
    tweet: { id: 's2', handle: 'spam2', text: 'Escort services in your city 💋 DM for menu, available tonight', media: [], context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '纯图片短文案',
    tweet: { id: 's3', handle: 'spam3', text: '看', media: ['https://pbs.twimg.com/media/x.jpg?name=small'], mediaSkinRatio: 0.83, context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '显示名引流（正文无害）',
    tweet: {
      id: 's4',
      handle: 'JesseAlvarl3',
      displayName: '🍑真实同城约p🍑主页联系🔞免费',
      text: '那一夜你没有拒绝我😭🤣不是人机',
      media: [],
      context: 'timeline',
    },
    expect: 'expectHidden',
  },
  {
    name: '无任何关键词（骚式自夸）',
    tweet: {
      id: 's5',
      handle: 'yrmyzhcxvlkzpu',
      displayName: 'yrmyzh cxvlu',
      text: '比我好看的没我骚🔧👏比我骚的没我好看',
      media: [],
      context: 'timeline',
    },
    expect: 'expectHidden',
  },
  {
    name: '处男免费农场#1（emoji 拆字）',
    tweet: {
      id: 's16',
      handle: 'czex7Jacquline',
      displayName: '不药而愈丶❤️处男免费❤️',
      text: '祝你有美好的一天🟧处🐕男🚹恭喜 发财',
      media: [],
      context: 'reply',
    },
    expect: 'expectHidden',
  },
  {
    name: '处男免费农场#2（同文案）',
    tweet: {
      id: 's17',
      handle: 'KhadijahLo9err',
      displayName: 'ヾ、 秂鴇銘❤️处男免费❤️',
      text: '祝你有美好的一天🐊处🔪男恭喜 发财',
      media: [],
      context: 'reply',
    },
    expect: 'expectHidden',
  },
  {
    name: '主页匹配家族（正文无害）',
    tweet: {
      id: 's15',
      handle: 'ArethaLaur666',
      displayName: '💎主页匹配💎无套路匹配💎覆盖全国',
      text: '那一夜你没有拒绝我🤤🧠不是人机',
      media: [],
      context: 'timeline',
    },
    expect: 'expectHidden',
  },
  {
    name: '太阳射+女大找炮友',
    tweet: {
      id: 's13',
      handle: 'lisa82am4',
      displayName: '巧倩💦女大找炮友🔥',
      text: '太阳射☀️不进去的地方💪你可以',
      media: [],
      context: 'reply',
    },
    expect: 'expectHidden',
  },
  {
    name: '太阳射+处男无偿',
    tweet: {
      id: 's14',
      handle: 'lori73sv6',
      displayName: '乐乐❤️处男无偿❤️',
      text: '太阳射☀️不进去的地方💪你可以',
      media: [],
      context: 'reply',
    },
    expect: 'expectHidden',
  },
  {
    name: '成人内容创作者（非引流）',
    tweet: { id: 's6', handle: 'creator1', text: 'My OnlyFans is 50% off today, link in bio 💕', media: [], context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '农场#1（同文案）',
    tweet: { id: 'fs1', handle: 'ThomasTurnyysr', displayName: '靖柏🌸', text: '应该没人比我玩的开了吧🤣💖我福不黑不信你看', media: [], context: 'reply' },
    expect: 'mustNotHide',
  },
  {
    name: '农场#2（同文案）',
    // 阈值是 2 个账号：第二条就成立（#1 当时只有 1 个账号，所以放行）
    tweet: { id: 'fs2', handle: 'TinaMysersyro', displayName: '夜蓉🌸', text: '应该没人比我玩的开了吧🤣💖我福不黑不信你看', media: [], context: 'reply' },
    expect: 'expectHidden',
  },
  {
    name: '农场#3（同文案）',
    tweet: { id: 'fs3', handle: 'TimothyAndjqqx', displayName: '迎晴🌸', text: '应该没人比我玩的开了吧🤣💖我福不黑不信你看', media: [], context: 'reply' },
    expect: 'expectHidden',
  },
  {
    name: '农场变体#1（插「蝎」）',
    tweet: { id: 's23', handle: 'MaribelTebhz', displayName: 'Maribel Tebow', text: '比我好看的没我骚蝎🐾比我骚的没我好看', media: [], context: 'reply' },
    expect: 'expectHidden',
  },
  {
    name: '农场变体#2（近似+重复两遍）',
    tweet: {
      id: 's24',
      handle: 'ShanteUusakr',
      displayName: 'Shantel Just',
      text: '比我好看的没我骚🐾💩比我骚的没我好看\n比我好看的没我骚🐾💩比我骚的没我好看',
      media: [],
      context: 'reply',
    },
    expect: 'expectHidden',
  },
  {
    name: '玩的开变体（单条孤立）',
    tweet: { id: 's25', handle: 'ShawanaLafavor', displayName: 'Shawana Lafavor', text: '没人比我玩的开了吧🤣💩我福不黑不信你看', media: [], context: 'reply' },
    // 已知残差：模型对这条单条文案只给 junk 0.43 / ordinary —— 只靠内容判不出来。
    // 真实时间线里它会被「近似文案农场」兜住（同一模板的其他账号一发就成簇），
    // 但完全孤立时仍会漏；这里只记录、不计成败，保持诚实。
    expect: 'knownGap',
  },
  {
    name: 'β 重复·代表条',
    // 两条是**同一件事的两种写法**（改了「在地铁上→坐地铁时」），本地近似度 0.68：
    // 高于 β 候选门槛 0.45、低于农场聚类门槛 0.8 —— 正好只该由 β 折叠，而不是被当成农场刷屏。
    tweet: { id: 'b1', handle: 'commuter_a', text: '今天在地铁上看到有人给老人让座，感觉挺暖的', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    name: 'β 重复·语义相同（改写）',
    tweet: { id: 'b2', handle: 'commuter_b', text: '今天坐地铁时看到有人给老人让座，感觉挺暖的', media: [], context: 'timeline' },
    expect: 'expectBetaFolded',
  },
  {
    name: 'α 线程·多数#1',
    tweet: { id: 'a1', handle: 'reply_a', text: '这个政策我支持，方向是对的', media: [], context: 'reply', threadId: '1912000000000000001' },
    expect: 'mustNotHide',
  },
  {
    name: 'α 线程·多数#2',
    tweet: { id: 'a2', handle: 'reply_b', text: '支持，方向没问题', media: [], context: 'reply', threadId: '1912000000000000001' },
    expect: 'mustNotHide',
  },
  {
    name: 'α 线程·多数#3',
    tweet: { id: 'a3', handle: 'reply_c', text: '我也支持这个方向', media: [], context: 'reply', threadId: '1912000000000000001' },
    expect: 'mustNotHide',
  },
  {
    name: 'α 线程·少数派观点',
    tweet: { id: 'a4', handle: 'reply_d', text: '我不同意，公开数据其实是反过来的，去年同类政策让成本涨了三成', media: [], context: 'reply', threadId: '1912000000000000001' },
    expect: 'expectAlphaHit',
  },
  {
    name: '诈骗·荐股（内幕/稳赚）',
    tweet: { id: 's18', handle: 'stockguru88', text: '内幕消息：跟随老师操作，月入十万，稳赚不赔，加V领取建仓表', media: [], context: 'timeline' },
    expect: 'expectBlock',
  },
  {
    name: '诈骗·博彩（首充返水）',
    tweet: { id: 's19', handle: 'bet888win', text: '新平台首充送彩金，返水 1.5%，加群下注，日结', media: [], context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '标题党（删前速看）',
    tweet: { id: 's20', handle: 'buzzfeed_cn', text: '不看后悔一辈子！删前速看，99%的人都不知道的真相', media: [], context: 'timeline' },
    expect: 'expectHideOnly',
  },
  {
    name: '低质 AI 填充',
    tweet: { id: 's21', handle: 'aiblog_zh', text: '作为一个AI，以下是关于健康饮食的一些思考。综上所述，希望对你有帮助。', media: [], context: 'timeline' },
    expect: 'expectHidden',
  },
  {
    name: '正常商业广告（可隐藏不可拉黑）',
    tweet: { id: 's22', handle: 'coffee_brand', text: '新品上市：手冲咖啡机限时 8 折，详情见官网', media: [], context: 'timeline' },
    expect: 'mustNotBlock',
  },
  {
    name: '日常闲聊',
    tweet: { id: 's7', handle: 'normal1', text: '今天天气不错，我们一起去公园散步吧，顺便看看新开的书店。', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    name: '治理类新闻',
    tweet: { id: 's8', handle: 'news1', text: '警方通报：专项行动打击约炮平台与色情网站，已查处多个窝点，抓获嫌疑人若干。', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    name: '性教育科普',
    tweet: { id: 's9', handle: 'edu1', text: '性教育读本：如何与青少年讨论色情内容的危害与网络自护，附家长沟通建议。', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    name: '泳装擦边',
    tweet: { id: 's10', handle: 'photo1', text: '夏天的泳装写真分享，海边风景真不错🏖️', media: ['https://pbs.twimg.com/media/y.jpg?name=small'], mediaSkinRatio: 0.62, context: 'timeline' },
    expect: 'mustNotBlock',
  },
  {
    name: '正常小性感（对照）',
    tweet: { id: 's11', handle: 'alice', displayName: 'Alice', text: '今晚的裙子有点短，但我觉得挺好看的，朋友聚会开心', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    name: '健身自拍（对照）',
    tweet: { id: 's12', handle: 'fitlife', displayName: '健身博主', text: '今天练了腿，深蹲 100kg 五组，明天继续', media: [], context: 'timeline' },
    expect: 'mustNotHide',
  },
  {
    // 以下三条是用户 2026-09 发来的真站截图（X 回复区「可能的垃圾信息」分区）：
    // 两条显示名带引流词、正文是同一句只差 emoji；第三条正文只有三个字。
    name: '真站·X 垃圾分区（已老实）',
    tweet: { id: 'r1', handle: 'for520vox', displayName: '莫长渝', text: '已老实', context: 'reply', spamSection: true, threadId: '1900000000000000009' },
    expect: 'expectHidden',
  },
  {
    name: '真站·找炮友 + 只入身体',
    tweet: { id: 'r2', handle: 'jennifer73pe6', displayName: '寒松❤️找炮友🍾', text: '只入身体🥦🌰不入生活', context: 'reply', threadId: '1900000000000000009' },
    expect: 'expectHidden',
  },
  {
    // 同一天的第四条真站截图：账号名是乱码串（`eomgdu vxbjw` / @eomgduvbxj92qp），只有一条黑话。
    // 加规则前：本地零信号 → 只有廉价预检 0.69 → 只到「待确认」；加规则后：强规则直接送完整五问。
    name: '真站·乱码账号名 + 单条黑话',
    tweet: { id: 'r4', handle: 'eomgduvbxj92qp', displayName: 'eomgdu vxbjw', text: '只入身体😔😊不入生活', context: 'reply', threadId: '1900000000000000011' },
    expect: 'expectHidden',
  },
  {
    // 用户第三批截图（2026-09）：同一批农场账号的三条。
    // ① 另一个模板的引流黑话 + 干净显示名 → 模型给 ordinary，靠 review 下限兜住；
    // ② 显示名「处男无偿」+ 只入身体 → hide；③ 带前导/尾随 emoji 的变体 → hide。
    name: '真站·玩归玩闹归闹…看福',
    tweet: { id: 'r5', handle: 'JonathanFifety', displayName: 'Jonathan Fisher', text: '玩归玩闹归闹🌹🍷给你看福👍我不开玩笑 X 6', context: 'reply', threadId: '1900000000000000021' },
    expect: 'expectHidden',
  },
  {
    name: '真站·处男无偿 + 只入身体',
    tweet: { id: 'r6', handle: 'heather68bf2', displayName: '.瑾锦 ❤️处男无偿❤️', text: '只入身体🌻😊不入生活', context: 'reply', threadId: '1900000000000000022' },
    expect: 'expectHidden',
  },
  {
    name: '真站·前导尾随 emoji 变体',
    tweet: { id: 'r7', handle: 'FrankEdwar5vpy', displayName: 'Frank Edwards', text: '👆只入身体❤️👄不入生活。 4 🚶', context: 'reply', threadId: '1900000000000000023' },
    expect: 'expectHidden',
  },

  {
    name: '真站·同城无偿约 + 同句变体',
    tweet: { id: 'r3', handle: 'jessica31kz6', displayName: '傲旋🌸同城无偿约🌸', text: '只入身体🦵💪不入生活', context: 'reply', threadId: '1900000000000000009' },
    expect: 'expectHidden',
  },
];

/**
 * 额外样本（可选）：`JEV_SAMPLES_FILE=/path/samples.json node tools/live-check.js`
 * 用来把真站随手抓到的样本直接喂进同一条流水线，不用改脚本。
 * 格式：[{ name, tweet: { handle, displayName, text, context, media?, threadId? }, expect? }]
 * （expect 省略时按 knownGap 处理：只记录、不计成败。）
 */
function loadExtraSamples() {
  const file = process.env.JEV_SAMPLES_FILE || '';
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('样本文件必须是数组');
  return raw.map((item, index) => {
    if (!item?.tweet || typeof item.tweet.text !== 'string') throw new Error(`样本 ${index} 缺 tweet.text`);
    return {
      name: item.name || `额外样本 #${index + 1}`,
      tweet: { id: item.tweet.id ?? `x${index + 1}`, media: [], context: 'timeline', ...item.tweet },
      expect: item.expect || 'knownGap',
    };
  });
}


// JEV_ONLY_EXTRA=1 时只跑 JEV_SAMPLES_FILE 里的样本：用来**隔离**测量单条真站样本，
// 不让内置样本的农场/窗口影响它（否则「单条」会被前面的同文案样本聚成农场）。
const ONLY_EXTRA = process.env.JEV_ONLY_EXTRA === '1';
const RUN_SAMPLES = ONLY_EXTRA ? loadExtraSamples() : [...SAMPLES, ...loadExtraSamples()];
if (ONLY_EXTRA && RUN_SAMPLES.length === 0) throw new Error('JEV_ONLY_EXTRA=1 需要同时给 JEV_SAMPLES_FILE');

const SOURCE_LABEL = { jev: '四问', triage: '预检', local: '本地', cache: '缓存', disabled: '已关闭' };

function pad(text, width) {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (/[\u2e80-\uffff]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, width - visual));
}

function fmt(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '-';
}

async function main() {
  console.log(`网关：${api.preset} · ${api.baseURL}${api.path} · 模型 ${api.model}`);
  console.log('跑的是扩展真正的流水线（含模型先行预检）；账号动作停在演练档，Key 来自环境变量。\n');
  console.log(
    `${pad('样本', 26)}${pad('档位', 8)}${pad('来源', 6)}${pad('色情', 6)}${pad('引流', 6)}${pad('欺骗', 6)}${pad('junk', 6)}${pad('类别', 18)}${pad('α', 7)}${pad('β', 7)}${pad('延迟', 8)}说明`,
  );

  let hardFail = 0;
  let softMiss = 0;

  let tokensIn = 0;
  let tokensOut = 0;

  for (const sample of RUN_SAMPLES) {
    const before = calls.length;
    currentSkinRatio = typeof sample.tweet.mediaSkinRatio === 'number' ? sample.tweet.mediaSkinRatio : null;
    const started = Date.now();
    const decision = await pipeline.decide(sample.tweet);
    const latency = Date.now() - started;

    const sampleCalls = calls.slice(before);
    let adult = null;
    let solicitation = null;
    let deceptive = null;
    let junk = null;
    let category = '-';
    let confidence = null;
    for (const { request, response } of sampleCalls) {
      tokensIn += response?.usage?.input_tokens ?? 0;
      tokensOut += response?.usage?.output_tokens ?? 0;
      const ids = Object.keys(request.questions ?? {});
      if (ids.length === 1 && ids[0] === 'junk') junk = response?.answers?.junk?.noul ?? null;
      else {
        adult = response?.answers?.adult?.noul ?? null;
        solicitation = response?.answers?.solicitation?.noul ?? null;
        deceptive = response?.answers?.deceptive?.noul ?? null;
        category = response?.answers?.category?.choice ?? '-';
        confidence = response?.answers?.category?.confidence ?? null;
      }
    }

    const hidden = decision.band !== 'ignore';
    const betaFolded = decision.beta?.folded === true;
    const alphaHit = decision.alpha?.hit === true;
    const violated =
      (sample.expect === 'mustNotHide' && hidden) ||
      (sample.expect === 'mustNotBlock' && decision.band === 'block') ||
      (sample.expect === 'expectHideOnly' && decision.band === 'block');
    const infoOnly = sample.expect === 'knownGap';
    const missed = !infoOnly && ((sample.expect === 'expectHidden' && !hidden) ||
      (sample.expect === 'expectBlock' && decision.band !== 'block') ||
      (sample.expect === 'expectHideOnly' && !hidden) ||
      (sample.expect === 'expectBetaFolded' && !betaFolded) ||
      (sample.expect === 'expectAlphaHit' && !alphaHit));
    if (violated) hardFail += 1;
    if (missed) softMiss += 1;

    const mark = violated ? '  ✗ 违反安全底线' : missed ? '  ⚠ 未达期望' : infoOnly ? '  · 已知残差（不计成败）' : '  ✓';
    const tier = sampleCalls.map(({ request }) => (Object.keys(request.questions).length === 1 ? '预检' : '五问')).join('+') || '未调用';
    const would =
      decision.accountAction?.kind && decision.accountAction.kind !== 'none'
        ? `would=${decision.accountAction.kind}(${decision.accountAction.reason})`
        : '无动作';
    console.log(
      `${pad(sample.name, 24)}${pad(decision.band, 8)}${pad(SOURCE_LABEL[decision.source] ?? decision.source, 6)}` +
        `${pad(fmt(adult), 6)}${pad(fmt(solicitation), 6)}${pad(fmt(deceptive), 6)}${pad(fmt(junk), 6)}` +
        `${pad(category, 18)}${pad(fmt(decision.alpha?.score), 7)}${pad(fmt(decision.beta?.similarity), 7)}` +
        `${pad(`${latency}ms`, 8)}[${tier} → ${decision.reasons.join(',') || '无'}；${would}]${mark}`,
    );
    if (decision.farm?.hit) {
      console.log(`${pad('', 24)}  文案农场命中：同文案已有 ${decision.farm.accounts} 个不同账号（UI 会把更早的那几条一并隐藏）`);
    }
    if (decision.skip) console.log(`${pad('', 24)}  本地跳过：${decision.skip}`);
    if (decision.prefilter?.strongNameHit) console.log(`${pad('', 24)}  显示名自身即色情引流（strongNameHit）`);
    if (decision.prefilter?.randomName) console.log(`${pad('', 24)}  账号名疑似随机串（弱特征 +1，单独不足以隐藏）`);
  }

  const stats = pipeline.stats();
  console.log(`\n安全底线违反：${hardFail}   期望隐藏未命中：${softMiss}`);
  console.log(
    `调用统计：共 ${stats.jevCalls} 次（预检 ${stats.triageProbes} · 预检命中 ${stats.triageHits} · 升级五问 ${stats.triageEscalated}）` +
      `，token 输入 ${tokensIn} / 输出 ${tokensOut}`,
  );
  // 按调用类型拆 token：α/β 的成本必须能被单独看到（AC20：语义层每次调用花了多少）。
  const kindOf = (request) => {
    const ids = Object.keys(request?.questions ?? {});
    if (ids.length === 1 && ids[0] === 'junk') return 'probe';
    if (ids.includes('adult') && ids.includes('category')) return 'filter';
    return 'semantics';
  };
  const split = { probe: { n: 0, in: 0, out: 0 }, filter: { n: 0, in: 0, out: 0 }, semantics: { n: 0, in: 0, out: 0 } };
  for (const call of calls) {
    const bucket = split[kindOf(call.request)];
    bucket.n += 1;
    bucket.in += call.response?.usage?.input_tokens ?? 0;
    bucket.out += call.response?.usage?.output_tokens ?? 0;
  }
  console.log(
    `按类型拆 token：预检 ${split.probe.n} 次（输入 ${split.probe.in} / 输出 ${split.probe.out}）· ` +
      `五问 ${split.filter.n} 次（输入 ${split.filter.in} / 输出 ${split.filter.out}）· ` +
      `${'α/β 语义'} ${split.semantics.n} 次（输入 ${split.semantics.in} / 输出 ${split.semantics.out}` +
      `${split.semantics.n ? `，单次约 ${Math.round(split.semantics.in / split.semantics.n)} 输入 token` : ''}）`,
  );
  console.log(
    `语义层：β 折叠 ${stats.semantics?.betaFolds ?? 0} · α 标记 ${stats.semantics?.alphaHits ?? 0} · 调用 ${stats.semantics?.calls ?? 0} · 跳过 ${stats.semantics?.skipped ?? 0} · 失败 ${stats.semantics?.errors ?? 0}`,
  );
  console.log(
    `档位分布：${Object.entries(stats.bands).map(([k, v]) => `${k}=${v}`).join(' ')}；缓存命中 ${stats.cacheHits}；本地跳过 ${stats.skips}`,
  );
  if (hardFail > 0) {
    console.log('结论：真实模型在「不该动」的样本上被判到了 hide/block，请提高阈值或补充白名单。');
    process.exitCode = 1;
  } else {
    console.log('结论：安全底线全部通过（没有任何「不该隐藏/不该拉黑」的样本被拦）。');
  }
}

main().catch((error) => {
  console.error('真实模型验证异常：', error);
  process.exitCode = 1;
});
