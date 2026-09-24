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
  support: {
    label: '支持',
    cores: ['支持', '赞成', '赞同', '附议', '认同', '同意', '同感', '加油', '顶', '点赞', '好的', '可以', '行的', '收到', '说得对', '有道理', '正解', '1'],
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
  /** 纯 emoji / 表情符号：知道是情绪，但分不出哪一类。 */
  emoji: {
    label: '表情',
    cores: [],
  },
};

const INTENSIFIERS = [
  '完全', '非常', '十分', '超级', '绝对', '真的', '实在', '我也', '我也是', '确实是', '确实', '确实很',
  '确实太', '也太', '有点', '很', '好', '太', '也', '就', '无敌', '特别', '特么', '真是',
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

function stripFillers(text) {
  let rest = text;
  for (let i = 0; i < 2 && rest.length > 1 && FILLER.test(rest[0]); i += 1) rest = rest.slice(1);
  for (let i = 0; i < 2 && rest.length > 1 && FILLER.test(rest[rest.length - 1]); i += 1) rest = rest.slice(0, -1);
  return rest;
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
  for (const base of [text, collapsed, stripIntensifier(text), stripIntensifier(collapsed)]) {
    variants.add(base);
    variants.add(stripFillers(base));
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
  if ([...text].length > LOW_SIGNAL_MAX_CHARS) return null;
  if (SUBSTANTIVE.test(text)) return null;
  // 数字基本意味着有内容（"3 天"、"100 分"）；只有 `1`/`+1`/`111` 这类「加一」例外。
  if (/[0-9]/.test(text) && !/^\+?1+$/.test(text)) return null;

  return matchClass(text);
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
 * @param {{ mode?: 'fold'|'hide' }} [options]
 *   - `fold`：留最早的一条当代表（页面上加「情绪：XX」徽标），其余折叠
 *   - `hide`：**全部**折叠（用户说的「删除」）—— 连代表条也不显示内容，条上写明情绪类别
 * @returns {null|{duplicateOf: string|null, duplicateOfHandle: string|null, groupKey: string, groupSize: number,
 *   similarity: number, kind: 'emotion', emotion: string, emotionLabel: string, mode: 'fold'|'hide',
 *   representative: boolean, folded: boolean}}
 */
export function planEmotionFold(target, recent = [], options = {}) {
  const cls = classifyEmotion(target?.text);
  if (!cls) return null;
  const thread = target?.threadId ?? null;
  if (!thread) return null;
  const mode = options.mode === 'hide' ? 'hide' : 'fold';
  const selfSeq = Number.isFinite(target?.seq) ? target.seq : null;

  // 只看**比本条更早观察到**的同线程同类情绪（seq 是观察顺序，并发下也会乱序，所以必须比较 seq）。
  const earlier = (recent ?? []).filter((item) => {
    if (!item) return false;
    if (selfSeq !== null && !(Number(item.seq) < selfSeq)) return false;
    if (item.seq === target?.seq) return false;
    if (item.threadId !== thread) return false;
    if (classifyEmotion(item.text) !== cls) return false;
    if (target?.id && item.id && item.id === target.id) return false;
    return true;
  });

  const sorted = [...earlier].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
  const first = sorted[0] ?? null;
  const groupSize = sorted.length + 1;
  // fold：线程里同类情绪的**第一条**是代表条（不折叠，挂「情绪：XX」徽标）；其余折叠。
  // hide：所有人都折叠（用户说的「删除」），条上写明这是哪一类情绪。
  const representative = mode === 'fold' && sorted.length === 0;
  return {
    duplicateOf: first?.id ?? null,
    duplicateOfHandle: first?.handle ?? null,
    groupKey: `em:${thread}:${cls}`,
    groupSize,
    similarity: 1,
    kind: 'emotion',
    emotion: cls,
    emotionLabel: emotionLabel(cls),
    mode,
    representative,
    folded: !representative,
  };
}

/** 兼容旧名（v0.4.2）：等同于 `planEmotionFold(target, recent, { mode: 'fold' })`。 */
export function planLowSignalFold(target, recent = []) {
  return planEmotionFold(target, recent, { mode: 'fold' });
}
