/**
 * 低信息量附和识别（本地、0 次模型调用）。
 *
 * 用户 2026-09 的需求：「情绪、认同、确定 之类的应该只显示一个」。
 *
 * 这些回复彼此**字符串不同**（`认同` / `确定` / `哈哈哈`），3-gram 相似度与文案农场都抓不到，
 * 但语义上属于同一类东西：**没有实质内容的情绪 / 认同 / 确认**。所以这里做一版本地分类，
 * 再由 pipeline 按「同一线程 + 同一类」折叠，只留最早的一条。
 *
 * 三条设计原则：
 * 1. **保守**：只有「整串恰好是某条附和短语（可带加强语与语气词）」才算低信息量；
 *    `不同意` / `不确定` / `确实有问题` / `同意，但前提是…` 这类匹配不上任何核心，自然不会被折叠。
 * 2. **只在回复区、只按线程归组**：没有 threadId 就不折叠（宁可少折叠，也不要跨帖子乱折）。
 * 3. **纯展示**：折叠不改变 band / accountAction（不变量 I1），条上仍可「展开」看全部。
 */

/** 归一化：NFKC → 去零宽 → 只留 CJK/字母数字（emoji、标点、空白都吃掉）。 */
export function normalizeLowSignal(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/[^\u3400-\u9fffa-z0-9]/g, '');
}

/** 归一化后超过这个长度就不再是「附和」了。 */
export const LOW_SIGNAL_MAX_CHARS = 12;

/**
 * 出现这些词说明这条回复在讲事情（转折、理由、问题、建议…）→ 不折叠。
 * 这里**刻意不列**「不 / 没 / 别」等否定词：判定用的是「整串必须恰好是某条附和短语」，
 * `不同意` / `不确定` / `不认同` 本来就匹配不上任何核心；把否定词放进来反而会误伤 `没错`。
 */
const SUBSTANTIVE = /因为|所以|但是|不过|其实|建议|问题|为什么|怎样|怎么|需要|希望|应该|可能|如果|而且|另外|首先|其次|比如|例如|觉得|认为/;

/** 只有这些「核心（+ 可选的加强语 / 语气词）」才算附和。 */
const CORES = {
  agreement: [
    '认同', '同意', '赞成', '赞同', '附议', '支持', '同感', '说得对', '有道理', '对的', '对的呀',
    '是的', '对啊', '没错', '没毛病', '对', '对对', '可以', '行的', '收到', '同意以上', '+1', '1', '＋1',
  ],
  confirmation: ['确定', '确认', '的确', '确实', '果然', '就是这样', '正确', '是了', '就是', '准没错'],
  emotion: [
    '哈哈', '嘿嘿', '呵呵', '笑死', '笑不活了', '泪目', '哭了', '呜呜', '爱了', '可爱', '好可爱',
    '喜欢', '太可爱', '好萌', '绝了', '牛', '牛啊', '太强了', '太好了', '赞', '好耶', '笑',
  ],
};

const INTENSIFIERS = [
  '完全', '非常', '十分', '超级', '绝对', '真的', '实在', '我也', '我也是', '确实是', '确实', '确实很',
  '确实太', '也太', '有点', '很', '好', '太', '也', '就', '无敌', '特别',
];

/** 语气词：`认同呀` / `嗯嗯，对` / `实在是太赞了` 这种外围填充不影响判定。 */
const FILLER = /[啊呀呢吧的了嘛哦嗯诶哎唉是]/;

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

function matchCore(text) {
  const collapsed = collapseRuns(text);
  const variants = new Set();
  for (const base of [text, collapsed, stripIntensifier(text), stripIntensifier(collapsed)]) {
    variants.add(base);
    variants.add(stripFillers(base));
  }
  // 反复「去加强语 + 去语气词」：`实在是太赞了` → `是太赞了` → `太赞` → `赞`
  let current = collapsed;
  for (let i = 0; i < 3; i += 1) {
    const next = stripFillers(stripIntensifier(current));
    if (next === current || !next) break;
    variants.add(next);
    current = next;
  }
  for (const candidate of variants) {
    if (!candidate) continue;
    for (const [cls, cores] of Object.entries(CORES)) {
      for (const core of cores) {
        if (candidate === core || isRepetition(candidate, core)) return cls;
      }
    }
  }
  return null;
}

/**
 * 把回复分类成 `emotion` / `agreement` / `confirmation`，不是低信息量附和则返回 null。
 * @param {string} raw
 * @returns {'emotion'|'agreement'|'confirmation'|null}
 */
export function classifyLowSignal(raw) {
  const source = String(raw ?? '');
  const text = normalizeLowSignal(source);
  const hasEmoji = /[\p{Extended_Pictographic}\u2600-\u27bf]/u.test(source);

  // 纯 emoji / 纯表情符号（`😂😂`、`❤️`）就是情绪 —— 但一个孤立的问号不算。
  if (!text) return hasEmoji ? 'emotion' : null;
  if ([...text].length > LOW_SIGNAL_MAX_CHARS) return null;
  if (SUBSTANTIVE.test(text)) return null;
  // 数字基本意味着有内容（"3 天"、"100 分"）；只有 `1`/`+1`/`111` 这类「加一」例外。
  if (/[0-9]/.test(text) && !/^\+?1+$/.test(text)) return null;

  return matchCore(text);
}

/**
 * 同一线程里「同类附和」的折叠计划（0 次模型调用）。
 *
 * @param {{id?: string|null, handle?: string|null, text?: string, threadId?: string|null, seq?: number, ts?: number}} target
 * @param {Array<object>} recent 近期观察到的推文（`semanticRecent.list()`）
 * @returns {null|{duplicateOf: string|null, duplicateOfHandle: string|null, groupKey: string, groupSize: number,
 *   similarity: number, kind: 'agreement', lowSignal: string, folded: true}}
 */
export function planLowSignalFold(target, recent = []) {
  const cls = classifyLowSignal(target?.text);
  if (!cls) return null;
  const thread = target?.threadId ?? null;
  if (!thread) return null;

  const sameThread = (recent ?? []).filter((item) => {
    if (!item || item.seq === target?.seq) return false;
    if (item.threadId !== thread) return false;
    if (classifyLowSignal(item.text) !== cls) return false;
    if (target?.id && item.id && item.id === target.id) return false;
    return true;
  });
  if (sameThread.length === 0) return null;

  const sorted = [...sameThread].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.ts ?? 0) - (b.ts ?? 0));
  const first = sorted[0];
  return {
    duplicateOf: first.id ?? null,
    duplicateOfHandle: first.handle ?? null,
    groupKey: `ls:${thread}:${cls}`,
    groupSize: sorted.length + 1,
    similarity: 1,
    kind: 'agreement',
    lowSignal: cls,
    folded: true,
  };
}
