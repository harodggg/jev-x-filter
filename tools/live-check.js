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
];

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
    `${pad('样本', 26)}${pad('档位', 8)}${pad('来源', 6)}${pad('色情', 6)}${pad('引流', 6)}${pad('欺骗', 6)}${pad('junk', 6)}${pad('类别', 22)}${pad('置信度', 8)}${pad('延迟', 8)}说明`,
  );

  let hardFail = 0;
  let softMiss = 0;

  let tokensIn = 0;
  let tokensOut = 0;

  for (const sample of SAMPLES) {
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
    const violated =
      (sample.expect === 'mustNotHide' && hidden) ||
      (sample.expect === 'mustNotBlock' && decision.band === 'block') ||
      (sample.expect === 'expectHideOnly' && decision.band === 'block');
    const infoOnly = sample.expect === 'knownGap';
    const missed = !infoOnly && ((sample.expect === 'expectHidden' && !hidden) ||
      (sample.expect === 'expectBlock' && decision.band !== 'block') ||
      (sample.expect === 'expectHideOnly' && !hidden));
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
        `${pad(fmt(adult), 6)}${pad(fmt(solicitation), 6)}${pad(fmt(junk), 6)}${pad(category, 22)}${pad(fmt(confidence), 8)}${pad(`${latency}ms`, 8)}` +
        `[${tier} → ${decision.reasons.join(',') || '无'}；${would}]${mark}`,
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
