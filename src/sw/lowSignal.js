/**
 * 情绪 / 态度分类（本地、0 次模型调用）。
 *
 * 需求演进：
 * 1. 用户：「情绪 认同 确定 之类的应该只显示一个」→ v0.4.2 加了本地分类 + 同线程折叠。
 * 2. 用户：「把所有的情绪言论给折叠/删除，然后给予愤怒，喜悦，支持，反对，之类的信息」
 *    → 本文件升级为**情绪分类器**：愤怒 / 喜悦 / 支持 / 反对 / 悲伤 / 确认 / 表情，
 *      并支持两种呈现（fold = 留一条代表 + 其余折叠；hide = 全部折叠/隐藏），
 *      折叠条上写明属于哪一类情绪。
 *
 * 三条设计原则：
 * 1. **保守**：只有「整串恰好是某条情绪短语（可带加强语与语气词）」才算情绪言论；
 *    `我不同意，公开数据其实是反过来的`（讲理由）/ 疑问句 / 带数字或链接 / 超长文本
 *    一律不折叠 —— 要折叠的是情绪，不是论点。
 * 2. **只在回复区、只按线程归组**：没有 threadId 就不处理（宁可少折叠，也不要跨帖子乱折）。
 * 3. **纯展示**：折叠/隐藏只改呈现（保留 `<article>`、只藏子节点），**不改 band、
 *    不改 accountAction**（不变量 I1）。条上永远可以「展开」看全部。
 */

/** 归一化：NFKC → 去零宽 → 只留 CJK/字母数字（emoji、标点、空白都吃掉）。 */
export function normalizeLowSignal(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/[^\u3400-\u9fffa-z0-9]/g, '');
}

/** 归一化后超过这个长度就不再是「一句话情绪」了（论点/细节不折叠）。 */
export const LOW_SIGNAL_MAX_CHARS = 12;

/** 线程内把各类低信息量附和合并成一条时，折叠条上用的总标签。 */
export const LOW_INFO_LABEL = '低信息量附和';

/**
 * 附和模板的字符上限（比核心短语宽 2 个字）。
 * 真站样本 `好事多磨什么时候可以来一份` 归一化后是 13 字 —— 核心短语表那条 12 字的线
 * 是为了「论点不折叠」，而模板是整串锚定的固定句式，可以多让 2 个字。
 */
export const TEMPLATE_MAX_CHARS = 14;

/**
 * 出现这些词说明这条回复在讲事情（转折、理由、问题、建议…）→ 不当作情绪言论。
 * 刻意**不列**「不 / 没 / 别」：用户要折叠的「反对」本身就是否定（`不同意` / `不行`），
 * 而判定用的是「整串必须恰好是某条情绪短语」，`不同意，但前提是…` 会因为太长或含转折词被排除。
 */
const SUBSTANTIVE = /因为|所以|但是|不过|其实|建议|问题|为什么|怎样|怎么|需要|希望|应该|可能|如果|而且|另外|首先|其次|比如|例如|觉得|认为|数据|统计|政策|方案|成本|证据/;

/**
 * 情绪类别表：class → 中文标签 + 短语表（按顺序匹配，先命中先算）。
 * 顺序有讲究：`离谱` 归「愤怒」，`呵呵` 归「反对」——同一短语只出现在一个类别里。
 */
export const EMOTION_CLASSES = {
  anger: {
    label: '愤怒',
    cores: ['生气', '气死', '恶心', '离谱', '无语', '服了', '过分', '凭什么', '不爽', '恼火', '火大', '破防', '傻逼', '傻x', '垃圾', '滚', '操', '艹', '妈的', 'md'],
  },
  joy: {
    label: '喜悦',
    cores: ['哈哈', '嘿嘿', '笑死', '笑不活了', '开心', '高兴', '太好了', '好耶', '爽', '舒服', '绝了', '妙', '有趣', '有意思', '赞', '牛', '牛啊', '太强了', '可爱', '喜欢', '爱了'],
  },
  greeting: {
    label: '问候',
    cores: ['gm', 'gn', '早上好', '早安', '午安', '晚安', '你好', '您好', '大家好', 'hi', 'hello', '哈喽', '新年快乐'],
  },
  support: {
    label: '支持',
    cores: ['支持', '赞成', '赞同', '附议', '认同', '同意', '同感', '加油', '顶', '点赞', '好的', '好', '可以', '行的', '收到', '说得对', '有道理', '正解', '1'],
  },
  oppose: {
    label: '反对',
    cores: ['反对', '不同意', '不认同', '不行', '不可以', '拒绝', '抵制', '差评', '拉黑', '举报', '呵呵', '算了吧', '别了吧'],
  },
  sadness: {
    label: '悲伤',
    cores: ['难过', '伤心', '泪目', '呜呜', '心碎', '遗憾', '太惨', '惨', '唉'],
  },
  confirmation: {
    label: '确认',
    cores: ['确定', '确认', '确实', '没错', '没毛病', '对的', '是的', '对啊', '的确', '果然', '正确', '就是这样', '是了', '就是'],
  },
  praise: {
    label: '赞美',
    cores: ['美女', '好看', '好美', '太美了', '太美', '漂亮', '真漂亮', '美极了', '好帅', '帅', '厉害', '优秀', '棒', '太棒了', '不错', '好评', '完美', '绝美'],
  },
  wish: {
    label: '期待',
    cores: ['我也想去', '想去', '好想去', '想要', '想买', '期待', '蹲一个', '蹲', '求', '许愿', '馋了', '羡慕'],
  },
  social: {
    label: '社交',
    cores: ['交朋友', '交友', '互关', '互粉', '求关注', '关注一下', '加个好友', '一起玩', '来个好友', '认识一下'],
  },
  /**
   * 参与 / 打卡（v0.4.7，真站截图：抽奖活动帖下面整屏的 `已三连`、`都来参加`）。
   * 这类回复没有任何信息量（不表达观点、不补充事实），是评论区里数量最多的一种噪音；
   * 短语表只放**动作本身**，带前缀/宾语的句式交给下面的模板。
   */
  participation: {
    label: '参与',
    cores: ['三连', '一键三连', '参加', '报名', '打卡', '签到', '集合', '上车', '走起', '冲了'],
  },
  /** 纯 emoji / 表情符号：知道是情绪，但分不出哪一类。 */
  emoji: {
    label: '表情',
    cores: [],
  },
};

/** 类别表的声明顺序：折叠条上的类别人数明细按这个顺序排（稳定、可断言）。 */
const CLASS_ORDER = Object.keys(EMOTION_CLASSES);

/**
 * 整串锚定的「附和模板」（v0.4.7）。
 *
 * 为什么需要它：核心短语表只认「整串恰好是某个词」，但真站评论区里数量最多的是
 * **带称呼 / 带宾语 / 带语气词**的低信息量附和 ——
 * `佳佳妹妹最好，最美！`、`这个活动好啊`、`已三连！！！`、`都来参加`、`三连了，希望能中🙏`、
 * `好事多磨，什么时候可以来一份`。用户截图里这 6 条实测**一条都没被识别**（全部 null）。
 *
 * 三条护栏保证它不退化：
 * 1. 每条模板都是 `^…$` **整串锚定**，词表是固定小集合，不是「包含即命中」；
 * 2. 仍然受全局闸门约束：归一化后 ≤ `LOW_SIGNAL_MAX_CHARS`(12) 字、无数字/链接；
 * 3. `guard: 'prefix'` 的模板允许一段自由前缀（`好事多磨`），但对前缀**额外**做
 *    实质词与否定词过滤 —— 否则 `成本太高可以来一份` 这种讲事情的句子会被吃掉。
 */
const EMOTION_TEMPLATES = [
  // —— 参与 / 打卡 ——
  // `已三连`、`都来参加`、`一键三连了`、`快报名吧`、`三连了希望能中`、`大家一起来参加一下吧`、`我要报名参加`、`已经三连过了`
  ['participation', /^(?:已|已经|都|也|我也|我也要|我|我要|一起|快|赶紧|大家|先|来|马上|立刻){0,3}(?:(?:一键)?(?:三连|参加|报名|打卡|签到|集合|上车|走起|冲了)){1,2}(?:了|啦|吧|呀|哦|咯|上|过了|一下|一个|一波|起来|一下吧|一下呀|了啦){0,2}(?:希望(?:能|可以)?中(?:奖)?|求中(?:奖)?|求好运|抽我|选我|中奖)?$/],
  // —— 许愿（参与式的后半截：`希望能中`、`求中奖`、`抽我`）——
  ['wish', /^(?:希望|求|祈祷)(?:这次|下次|这回|一定|真的|务必|能|可以){0,3}(?:中(?:奖|一个|一份)?|抽到(?:我)?|抽中(?:我)?|选我|好运|被选上)$/],
  // —— 赞美：带称呼的最高级 ——
  // `佳佳妹妹最好，最美！`：前缀必须是**称呼**（妹妹/姐姐/大佬/宝贝…），不是任意汉字。
  // 独立对抗审计抓到的误伤：`今天天气最好`、`这个方案最好`、`性价比最好`、`他的状态最好` ——
  // 它们的前缀不是称呼，所以这里改成白名单后缀，而不是「≤4 个任意汉字」。
  ['praise', /^(?:[\u4e00-\u9fff]{0,4}(?:妹妹|姐姐|哥哥|弟弟|小姐姐|小哥哥|老师|大佬|宝贝|宝|老婆|老公|女神|老板|博主|up主|太太|同学|医生))?最(?:好|美|漂亮|可爱|帅|厉害|棒|牛)(?:了|啦|呀|的)?(?:最(?:好|美|漂亮|可爱|帅|厉害|棒|牛)(?:了|啦|呀|的)?)?$/],
  // —— 赞美：带宾语的短评 —— `这个活动好啊`、`这期视频真不错`
  ['praise', /^(?:这个|这|这条|这期|这篇|本次|这场)?(?:活动|视频|帖子|内容|作品|直播|博主|妹妹|姐姐|哥哥|大佬|老师|同学|宝贝)?(?:真|太|好|很|超|挺|确实|是)?(?:好|棒|不错|赞|绝|美|帅|可爱|厉害|给力|顶|优秀)(?:啊|呀|了|啦|哦|的|吧|！)?$/],
  // —— 期待 / 求取 —— `好事多磨，什么时候可以来一份`（自由前缀 ≤4 字，另做实质词过滤）
  // 只留「来 / 上 / 安排」：审计发现 `合同什么时候可以给我` 会被「给」带进来（事务问句）。
  ['wish', /^([\u4e00-\u9fff]{1,4})(?:什么时候|何时|几时|哪天|哪次)?(?:可以|能|会|要|想)?(?:来|上|安排)(?:我|俺|咱)?(?:一)?(?:份|个|张|套|箱|杯|名|名额|链接|地址)?(?:吧|啊|呀)?$/, { guard: 'prefix' }],
];

/** 自由前缀里出现这些词说明这条在讲事情（理由 / 数据 / 成本 / 规则 / 日常事务…）→ 模板不得命中。 */
const PREFIX_BLOCKED = /不|没|别|成本|价格|价钱|费用|性价比|数据|方案|政策|规定|规则|原因|理由|时间|日期|时候|多少|为什么|怎样|怎么|需要|应该|建议|证据|统计|合同|退款|报告|样机|发票|工资|天气|心情|状态|质量|成绩|排名/;

/** 归一化后的整串模板匹配；命中返回类别，否则 null。 */
function matchTemplate(text) {
  for (const [cls, pattern, options] of EMOTION_TEMPLATES) {
    const hit = pattern.exec(text);
    if (!hit) continue;
    if (options?.guard === 'prefix') {
      const prefix = hit[1] ?? '';
      if (PREFIX_BLOCKED.test(prefix)) continue;
    }
    return cls;
  }
  return null;
}

const INTENSIFIERS = [
  '完全', '非常', '十分', '超级', '绝对', '真的', '实在', '我也', '我也是', '确实是', '确实', '确实很',
  '确实太', '也太', '有点', '很', '好', '太', '也', '就', '无敌', '特别', '特么', '真是', '真',
];

/** 语气词：`认同呀` / `嗯嗯，对` / `实在是太赞了` 这种外围填充不影响判定。 */
const FILLER = /[啊呀呢吧的了嘛哦嗯诶哎唉是我你他她它们人]/;

function stripIntensifier(text) {
  let rest = text;
  for (let i = 0; i < 2; i += 1) {
    const hit = INTENSIFIERS.find((word) => rest.startsWith(word) && rest.length > word.length);
    if (!hit) break;
    rest = rest.slice(hit.length);
  }
  return rest;
}

/**
 * 连续加强语的**每一步**中间形态。
 * 独立验证发现的漏判：`真好看` 会被连着削两次（`真` → `好`）变成 `看`，
 * 中间形态 `好看` 反而丢了。所以这里把每一步都留下。
 */
function intensifierVariants(text) {
  const out = [text];
  let rest = text;
  for (let i = 0; i < 2; i += 1) {
    const hit = INTENSIFIERS.find((word) => rest.startsWith(word) && rest.length > word.length);
    if (!hit) break;
    rest = rest.slice(hit.length);
    out.push(rest);
  }
  return out;
}

function stripFillers(text) {
  let rest = text;
  for (let i = 0; i < 2 && rest.length > 1 && FILLER.test(rest[0]); i += 1) rest = rest.slice(1);
  for (let i = 0; i < 2 && rest.length > 1 && FILLER.test(rest[rest.length - 1]); i += 1) rest = rest.slice(0, -1);
  return rest;
}

/**
 * 只削首 / 只削尾的中间形态。
 * 独立验证发现的漏判：`我服了` 被「先削首再削尾」削成 `服`，反而匹配不上核心 `服了`。
 */
function fillerVariants(text) {
  const out = new Set([text]);
  let head = text;
  for (let i = 0; i < 2 && head.length > 1 && FILLER.test(head[0]); i += 1) {
    head = head.slice(1);
    out.add(head);
  }
  let tail = text;
  for (let i = 0; i < 2 && tail.length > 1 && FILLER.test(tail[tail.length - 1]); i += 1) {
    tail = tail.slice(0, -1);
    out.add(tail);
  }
  return out;
}

/** 程度补语：`难过死了` / `笑死我了` / `气到哭` —— 核心 + 补语仍算同一类情绪。 */
const COMPLEMENTS = ['死了', '死我了', '死了吧', '爆了', '到哭', '哭了', '麻了', '疯了', '裂开', '到吐', '得想哭', '得要死'];

function stripComplement(text) {
  for (const suffix of COMPLEMENTS) {
    if (text.length > suffix.length && text.endsWith(suffix)) return text.slice(0, -suffix.length);
  }
  return null;
}

/** `哈哈哈哈` / `对对对` / `111` 这类重复先收敛成两遍，再按核心短语匹配。 */
function collapseRuns(text) {
  return text.replace(/(.)\1{2,}/g, '$1$1');
}

/** 「对对对」「哈」这种重复也归到对应核心。 */
function isRepetition(rest, core) {
  if (!core || rest.length < core.length) return false;
  if (rest.length % core.length !== 0) return false;
  for (let i = 0; i < rest.length; i += core.length) {
    if (rest.slice(i, i + core.length) !== core) return false;
  }
  return true;
}

function matchClass(text) {
  const collapsed = collapseRuns(text);
  const variants = new Set();
  const bases = new Set([text, collapsed, ...intensifierVariants(text), ...intensifierVariants(collapsed)]);
  for (const base of bases) {
    for (const v of fillerVariants(base)) variants.add(v);
    variants.add(stripFillers(base));
    const withoutComplement = stripComplement(base);
    if (withoutComplement) {
      variants.add(withoutComplement);
      variants.add(stripIntensifier(withoutComplement));
      for (const v of fillerVariants(withoutComplement)) variants.add(v);
    }
  }
  let current = collapsed;
  for (let i = 0; i < 3; i += 1) {
    const next = stripFillers(stripIntensifier(current));
    if (next === current || !next) break;
    variants.add(next);
    current = next;
  }
  for (const [cls, spec] of Object.entries(EMOTION_CLASSES)) {
    for (const core of spec.cores) {
      for (const candidate of variants) {
        if (!candidate) continue;
        if (candidate === core || isRepetition(candidate, core)) return cls;
      }
    }
  }
  return null;
}

/**
 * 把一条回复分类成情绪类别，不是情绪言论则返回 null。
 * @param {string} raw
 * @returns {'anger'|'joy'|'support'|'oppose'|'sadness'|'confirmation'|'emoji'|null}
 */
export function classifyEmotion(raw) {
  const source = String(raw ?? '');
  const text = normalizeLowSignal(source);
  const hasEmoji = /[\p{Extended_Pictographic}\u2600-\u27bf]/u.test(source);

  // 纯 emoji / 纯表情符号（`😂😂`、`❤️`）就是情绪 —— 但一个孤立的问号不算。
  if (!text) return hasEmoji ? 'emoji' : null;
  const chars = [...text].length;
  if (chars > TEMPLATE_MAX_CHARS) return null;
  // 数字基本意味着有内容（"3 天"、"100 分"）；只有 `1`/`+1`/`111` 这类「加一」例外。
  if (/[0-9]/.test(text) && !/^\+?1+$/.test(text)) return null;

  // 1) 核心短语表：讲事情的句子先被 SUBSTANTIVE 挡掉（`我不同意，公开数据其实是反过来的`）。
  if (chars <= LOW_SIGNAL_MAX_CHARS && !SUBSTANTIVE.test(text)) {
    const core = matchClass(text);
    if (core) return core;
  }
  // 2) 整串锚定的附和模板（v0.4.7）：核心表之外的「带称呼 / 带宾语 / 带前缀」句式。
  //    模板自身是整串锚定 + 固定小词表，所以允许它们绕过 SUBSTANTIVE ——
  //    `三连了希望能中` 里的「希望」是模板的一部分，不是在讲理由。
  return matchTemplate(text);
}

/** 兼容旧名（v0.4.2 的分类名）：支持/认同 → agreement，确认 → confirmation，其余 → emotion。 */
export function classifyLowSignal(raw) {
  const cls = classifyEmotion(raw);
  if (!cls) return null;
  if (cls === 'support') return 'agreement';
  if (cls === 'confirmation') return 'confirmation';
  return 'emotion';
}

export function emotionLabel(cls) {
  return EMOTION_CLASSES[cls]?.label ?? '情绪';
}

/**
 * 同一线程里**同类情绪**的折叠/隐藏计划（0 次模型调用）。
 *
 * @param {{id?: string|null, handle?: string|null, text?: string, threadId?: string|null, seq?: number, ts?: number}} target
 * @param {Array<object>} recent 近期观察到的推文（`semanticRecent.list()`）
 * @param {{ mode?: 'fold'|'hide', scope?: 'thread'|'feed' }} [options]
 *   - `mode=fold`：线程里留最早的一条当代表（挂「情绪：XX」徽标），其余折叠；
 *     `mode=hide`：**全部**折叠（用户说的「删除」），条上写明情绪类别
 *   - `scope=thread`（回复区 / 详情页）：**整条线程合并成一个组**（不再按类别分组，
 *     v0.4.7 起 `groupKey = em:<threadId>:low`），多条一起折叠时 `emotionLabel` 为
 *     「低信息量附和」并给出 `classes` / `classLabels` 明细；
 *     `scope=feed`（时间线/推荐流）：没有线程语义，**每条情绪言论各自折叠**并标出类别
 * @returns {null|{duplicateOf: string|null, duplicateOfHandle: string|null, groupKey: string, groupSize: number,
 *   similarity: number, kind: 'emotion', emotion: string, emotionLabel: string, mode: 'fold'|'hide',
 *   scope: 'thread'|'feed', representative: boolean, folded: boolean,
 *   classes?: Record<string, number>, classLabels?: string[]}}
 */
export function planEmotionFold(target, recent = [], options = {}) {
  const cls = classifyEmotion(target?.text);
  if (!cls) return null;
  const thread = target?.threadId ?? null;
  // 详情页的**主帖本身**（id 就是 URL 里的 status id）永远不参与折叠，也不能当代表条 ——
  // 那是用户正在读的那条推文。内容脚本会额外给 `threadRoot: true`，这里再按 id 自证一次。
  if (target?.threadRoot) return null;
  if (target?.id && thread && String(target.id) === String(thread)) return null;
  const mode = options.mode === 'hide' ? 'hide' : 'fold';
  // 时间线/推荐流：没有线程语义，每条情绪言论各自折叠 + 标类别（用户在时间线上要的正是这个）。
  const scope = options.scope ?? (target?.context === 'reply' || target?.threadId ? 'thread' : 'feed');
  if (scope === 'feed') {
    return {
      duplicateOf: null,
      duplicateOfHandle: null,
      groupKey: `em:feed:${cls}`,
      // 时间线上这条推文的原文预览（≤30 字）：折叠条上写出来，用户不用展开就知道折叠了什么
      contentPreview: String(target?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
      groupSize: 1,
      similarity: 1,
      kind: 'emotion',
      emotion: cls,
      emotionLabel: emotionLabel(cls),
      mode,
      scope: 'feed',
      representative: false,
      folded: true,
    };
  }
  if (!thread) return null;
  const selfSeq = Number.isFinite(target?.seq) ? target.seq : null;

  // v0.4.7：线程内**不再按类别分组** —— 用户要的是「这些东西折叠合并成同一条」。
  // 一条活动帖下面往往同时有赞美（`这个活动好啊`）、参与（`已三连`）、期待（`希望能中`）……
  // 它们的信息量都是零；按类别分组会得到三四条「代表条」，等于没合并。
  // 现在整条线程只留 1 条代表条（最早那条），其余全部折叠，条上写明各类别人数。
  // 只看**比本条更早观察到**的同类低信息量回复（seq 是观察顺序，并发下会乱序，所以必须比较 seq）。
  const earlier = (recent ?? []).filter((item) => {
    if (!item) return false;
    if (selfSeq !== null && !(Number(item.seq) < selfSeq)) return false;
    if (item.seq === target?.seq) return false;
    if (item.threadId !== thread) return false;
    // 主帖不能进入归组（否则整条线程的附和会折叠到主帖名下）。
    if (item.id && String(item.id) === String(thread)) return false;
    if (!classifyEmotion(item.text)) return false;
    if (target?.id && item.id && item.id === target.id) return false;
    return true;
  });

  const sorted = [...earlier].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
  const first = sorted[0] ?? null;
  const groupSize = sorted.length + 1;
  // 类别人数明细（含自己）：折叠条要写清「合并了什么」（参与 2 / 赞美 2 / 期待 1）。
  const classes = {};
  for (const item of [...sorted, target]) {
    const itemClass = classifyEmotion(item?.text) ?? cls;
    classes[itemClass] = (classes[itemClass] ?? 0) + 1;
  }
  const classKeys = Object.keys(classes);
  // fold：线程里低信息量附和的**第一条**是代表条（不折叠，挂徽标）；其余折叠。
  // hide：所有人都折叠（用户说的「删除」），条上写明这是哪一类情绪。
  const representative = mode === 'fold' && sorted.length === 0;
  return {
    duplicateOf: first?.id ?? null,
    duplicateOfHandle: first?.handle ?? null,
    groupKey: `em:${thread}:low`,
    scope: 'thread',
    groupSize,
    similarity: 1,
    kind: 'emotion',
    emotion: cls,
    // 本条自己的类别（保留 v0.4.4 的细粒度信息：用户要的「愤怒 / 喜悦 / 支持 / 反对」照旧能读到）
    emotionLabel: emotionLabel(cls),
    // 合并标签：整条线程只留一条代表条时，折叠条上要写清「这是把多少条什么合并了」
    merged: groupSize > 1 || classKeys.length > 1 ? LOW_INFO_LABEL : '',
    classes,
    classLabels: classKeys.map((key) => emotionLabel(key)),
    // 展示用短串（内容脚本直接用）：`愤怒 2 · 喜悦 1 · 支持 1 · 参与 1`
    // 排序：人数多的在前，同人数按类别表的声明顺序（稳定、可断言，不随字典序漂移）。
    classBreakdown: classKeys.length > 1
      ? Object.entries(classes)
        .sort((a, b) => b[1] - a[1] || CLASS_ORDER.indexOf(a[0]) - CLASS_ORDER.indexOf(b[0]))
        .map(([key, count]) => `${emotionLabel(key)} ${count}`)
        .join(' · ')
      : '',
    mode,
    representative,
    folded: !representative,
  };
}

/** 兼容旧名（v0.4.2）：等同于 `planEmotionFold(target, recent, { mode: 'fold' })`。 */
export function planLowSignalFold(target, recent = []) {
  return planEmotionFold(target, recent, { mode: 'fold' });
}
