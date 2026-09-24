# α / β 语义信息 · 产品规格与验收标准

| 项 | 值 |
| --- | --- |
| 文档 | `docs/ALPHA-BETA-SPEC.md`（本文件是 α/β 的**唯一产品口径**；实现细节冲突时以本文的定义与 AC 为准） |
| 目标版本 | 0.4.0（在 0.3.1「信息过滤器」之上加**语义层**） |
| 面向 | 开发（task-2 `src/sw`）、UX（task-4 `src/content`）、UI（task-3 `src/options`/`src/popup`）、Lead（终验） |
| 依赖现状 | `README.md` §2 判定四层、`docs/DESIGN.md` §6 不变量、`src/sw/farm.js` 近似去重、`tools/live-check.js` 真机口径 |
| 冻结接口 | `decision.beta` / `decision.alpha` / `tweet.threadId` / `settings.semantics` / `stats.semantics`（与 task-2/3/4 的标题字段逐字一致，见 §1.5 与 §8） |
| 一句话 | **β 把「同一信息的多次呈现」折叠成一次；α 把「相对评论区多数观点明显不同」的特殊观点标出来。两者都只是展示，绝不改变隐藏与账号动作。** |

---

## 0. 术语与角色

| 词 | 定义 |
| --- | --- |
| **信息单元** | 一条推文所传达的「同一件事 / 同一主张 / 同一结论」。判定单位是内容，不是账号、不是话题、不是关键词 |
| **β（贝塔信息）** | 同一信息单元在当前页面窗口里被重复呈现 → 只完整显示一条（**代表**），其余折叠成细条，可展开 |
| **代表（representative）** | 同组里**最早出现**且完整展示的那条；`beta.duplicateOf` 指向它的推文 id |
| **α（阿尔法信息）** | 相对**参考评论区**的多数观点，表达明显不同、且有实质内容的观点 → 只标记，不隐藏、不折叠、不降权 |
| **参考评论区** | 同一条根推文（同 `threadId`）下、扩展在当前页面会话里**已经判定过**的其它回复集合（≤ `maxReferences` 条） |
| **语义调用** | 附加在过滤判定之后的一次 Jev 批量调用，只回答 β/α 问题；**不参与** `band` 与 `accountAction` 的计算 |
| **纯展示** | 只新增 `decision.beta` / `decision.alpha` 字段与页面附着物；不改 `band` / `reasons` / `source` / `skip` / `accountAction` / 「已过滤」计数 |

---

## 1. 精确定义

### 1.1 β（贝塔信息）= 信息的重复呈现

**定义（判定对象是「信息」，不是「文本」）**

两条推文同时满足下面三点，就互为 β：

1. **同一信息单元**：在语义上说的是同一件事、同一主张或同一结论（`beta` 模型概率 ≥ `semantics.beta.threshold`）；
2. **没有新增量**：后一条没有带来新的事实、数据、来源、当事人或**立场表达**（引用带评论、回复带观点属于新增量）；
3. **可比较**：两条都达到最小信息量（归一化后 ≥ 10 个有效字符，与 `farm.js` 的 `FARM_MIN_CHARS` 同口径），且在本地候选筛选中进入过同一组。

判定后：一组里**只保留一条完整展示**（代表），其余 `folded = true`。

**三种重复强度（`beta.kind`，只影响显示文案，不影响是否折叠）**

| `kind` | 含义 | 例子 |
| --- | --- | --- |
| `verbatim` | 归一化后完全一致（去 emoji/标点/空白/大小写/零宽、折叠同句重复） | `应该没人比我玩的开了吧🤣我福不黑不信你看` ×2 条 |
| `paraphrase` | 措辞/语言不同，信息一致 | 中文原帖 + 其英文翻译；「今天在地铁上有人给老人让座，挺暖的」/「坐地铁时有人主动给老人让座，感觉很温暖」 |
| `same_claim` | 表达同一主张/结论，细节措辞差异较大 | 「这个政策方向是对的」/「我支持这项政策，方向没问题」 |

**代表规则（可观察）**

- 代表 = 同组里 **DOM 位置最靠上（更早出现）且当前完整展示** 的那条；`beta.duplicateOf` = 其推文 id。
- 代表自己的 `beta = { duplicateOf: null, groupKey, groupSize, similarity: 1, kind, folded: false }`；**只有 `groupSize ≥ 2` 时才返回非 null 的 `beta`**（组内只有自己 → 没有重复，什么都不显示）。
- 同页面会话内代表一旦确定**不再改判**（避免滚动时折叠目标来回跳）。
- 若最相似的候选本身已被隐藏（`band !== 'ignore'`）或已被折叠，则本条**不向其折叠**（`beta = null`）：不能把重复内容折进一条已经看不到的推文里。

**非目标（明确不做）**

| 不是 | 为什么 |
| --- | --- |
| 不是「同一账号连发」 | 账号相同不是 β 的判据：同一账号发两条**不同**内容不折叠；两条**内容相同**的推文即使同账号也折叠（重复的是信息，不是行为） |
| 不是「同一话题/关键词」 | 都提到「AI」「股市」不构成 β |
| 不是「同一事件的全部报道」 | 同一新闻的不同报道通常有不同事实、来源与角度 → 不折叠（除非通稿级近乎逐字相同） |
| 不是「引用/转发/表态」 | 带自己评论的引用推文是新增量，不折叠；纯引用默认也不折叠（见 §4 与 D7） |
| 不是「图片/视频相同」 | 图片不出网、本地只做像素统计，无法判语义；文字不同就不折叠 |
| 不是「过滤」 | 折叠不隐藏、不进 `band`、不进 `reasons`、不写 `hidden`、不计入「已过滤」徽标、不产生账号动作 |
| 不是「永久消失」 | 折叠条是细条占位，一键 `展开` 可完整还原，再点 `收起` 折回 |

### 1.2 α（阿尔法信息）= 相对评论区的特殊观点

**定义**

一条回复同时满足下面四点，α 命中（`hit = true`）：

1. **语境正确**：`tweet.context === 'reply'` 且 `tweet.threadId` 非空（默认 `alpha.onlyInReplies = true`）；
2. **有参考**：同 `threadId` 的可用参考评论 ≥ `semantics.alpha.minReferences`（默认 3）；
3. **相对不同**：「与这些参考评论的多数观点明显不同」的模型概率 ≥ `alpha.threshold`（默认 0.70）；
4. **有实质内容**：目标是一条**有主张的**表述（模型同时给出的差异显著度 ≥ 2/4 级，见 §2.2 A3）；单纯提问、口号、情绪、广告/垃圾不算。

**它是相对的，不是绝对的**

- 同一个观点在 A 条推文的评论区可能是 α，在 B 条推文下不是；**同一天里也可能翻转**（后续评论改变「多数」）。
- α **不判真假、不判对错**：与多数不同但事实上错误的观点也可以被标记（它只是「不同」的信号，不是「正确」徽章）。
- α **不表示价值高低**：不是「优质内容」，只是「值得单独看一眼的不同视角」。所以 UI 用中性/正向标记，**绝不能**用警告色、感叹号或「噪音」「异常」这类词。

**非目标（明确不做）**

| 不是 | 说明 |
| --- | --- |
| 不是「情绪激烈/语言粗鲁/吵架」 | 骂人但观点与多数一致 → 不标 |
| 不是「与我（用户）观点不同」 | 参照物是评论区多数，不是用户本人 |
| 不是「少数人点赞/低互动/小号」 | 互动量不参与判定 |
| 不是「错误信息/低质量」 | 那是六类过滤的职责；α 与过滤互不替代 |
| 不是「所有与众不同」 | 复述别人的少数观点、无实质内容的标语 → 不标 |
| 不是「提问/求推荐/玩梗」 | 没有可比较的主张 → 不标 |
| 不是「降权/隐藏/暗折叠」 | α 命中时推文**完整可见**，且 `beta.folded` 强制为 `false`（特殊观点不能被当成重复折叠掉） |

### 1.3 共同硬不变量（I-αβ，开发请写进代码注释并加单测）

**I-αβ.1 纯展示**：对任意推文，`settings.semantics.enabled = true` 与 `false` 两次判定，`band`、`reasons`、`source`、`skip`、`accountAction`、`detail` 中与过滤相关的字段**逐字段一致**；α/β 只在 `decision.beta` / `decision.alpha` 上不同。

**I-αβ.2 不占动作**：α/β 永不写入 `accountAction`，永不触发静音/拉黑，永不消耗 `maxActionsPerHour/Day`，永不进黑名单。

**I-αβ.3 不挤占过滤预算**：语义调用**计入**全局 `budget.maxJevPerDay`（`day.jev`）与全局分钟窗口，同时受 `semantics.maxPerMinute/maxPerDay` 约束；但全局额度必须给过滤**留保底** —— 只有 `budget.maxJevPerDay − day.jev > semantics.reserveForFiltering`（默认 50）**且**全局分钟窗口有余量时才允许语义调用。语义永远不挤占过滤额度（口径见 §5.3、裁决记录 §9）。

**I-αβ.4 可关闭且默认安全**：`semantics.enabled` 关掉后，网络层新增调用数 = 0，页面与 0.3.1 完全一致（只少了 α/β 附着物）。

**I-αβ.5 不猜**：模型答案缺字段/不合规 → 该项作废（`null`），绝不修补、绝不用默认值凑命中（与 `README` §2 I2 同一原则）。

**I-αβ.6 不阻塞**：语义调用挂在过滤判定**之后**、超时/失败只记统计，绝不改变本次判定的返回时机之外的行为（不得因为语义调用失败而让推文放行或隐藏）。

### 1.4 与既有「文案农场」的关系

| | 文案农场（0.3.1，`farm.js`） | β（本规格） |
| --- | --- | --- |
| 判据 | 结构证据：同段（近似）文案被 ≥2 个不同账号在 30 分钟内复制 | 信息证据：两条内容语义相同（模型 + 本地相似度） |
| 结局 | `band = hide`（真隐藏，进「已过滤」计数） | 纯展示折叠（不进 `band`、不进徽标计数） |
| 关系 | 农场命中后那些推文已经是 `hide`，**不需要也不做 β 折叠**（代表条目被隐藏 → 本条 `beta = null`） | β 小组不因重复而变成 `hide`；β 只在 `band === 'ignore'` 的条目之间发生 |

一句话：**农场是「过滤」，β 是「排版」。** 同一批内容被农场隐藏时，用户看到的是隐藏条；没有被农场判定的普通重复（例如两个人各自转述同一条消息）走 β 折叠。

### 1.5 冻结接口（逐字一致，不得改写）

```js
// SW → 内容脚本（可选字段；null = 本次没有 β/α 结论）
decision.beta = null | {
  duplicateOf: '1912345678901234567',   // 代表推文 id；代表自己为 null
  groupKey: 'bk_ab12cd34',              // 同组共享的稳定键
  groupSize: 2,                         // 含自己在内的同组数量（≥2 才返回非 null）
  similarity: 0.86,                     // 0..1，本条与代表的相似度（代表 = 1）
  kind: 'verbatim' | 'paraphrase' | 'same_claim',
  folded: true                          // true = 内容脚本折叠本条；代表恒为 false
  // 可选附加字段（不改变上述冻结字段语义，便于 UI 把 id 显示成 @handle）：
  // duplicateOfHandle: 'commuter_a' | null
};
decision.alpha = null | {
  hit: true,
  score: 0.72,                          // 0..1，「与多数不同」的模型概率
  reason: 'diverges_from_majority',     // 本地枚举，见 §8.3
  referenceCount: 5,                    // 实际参与对比的参考评论数
  summary: '与评论区多数观点不同'         // 中文短句，内容脚本直接显示
};
// 内容脚本 → SW
tweet.threadId = '1912345678901234567' | null;  // 状态页 /status/<id> 的根 id
// 设置（schema 仍为 2，新增字段走 mergeKnown 白名单）
settings.semantics = {
  enabled: true,
  beta: { enabled: true, threshold: 0.7, maxCandidates: 6, windowSize: 60, foldInFeed: true, foldInReplies: true },
  alpha: { enabled: true, onlyInReplies: true, threshold: 0.7, minReferences: 3, maxReferences: 12 },
  maxPerMinute: 10,
  maxPerDay: 300,
  reserveForFiltering: 50,   // 内部保底（裁决 §9.1）：全局日额度剩余必须 > 此值才允许语义调用；UI 不必暴露
};
// 统计
stats.semantics = { calls, betaFolds, alphaHits, skipped, errors };
```

---

## 2. 判定流程

### 2.0 位置与前提（一次推文的完整顺序）

```
预筛 → 农场 → 图片/视觉 → Jev 过滤判定 → 闸门 → 动作规划 → ★语义层（β/α，附加） → 缓存/审计/返回
                                                          ↑ 只有 band 与 accountAction 算完之后才做
```

进入语义层的条件（任一不满足即 `beta = alpha = null`，且**不调用模型**）：

| 前提 | 说明 |
| --- | --- |
| `settings.enabled` | 总开关 |
| 未被 prefilter 直接 skip | 白名单/自己发的/超短无媒体/关闭 scope 的推文不做语义判定（与过滤一致，避免给白名单账号花钱） |
| `settings.semantics.enabled`、且 β/α 各自的 `enabled` | 两级开关 |
| `tweet.threadId` 非空（α 用） | 内容脚本从 `location.pathname` 的 `/status/<id>` 取；取不到 → α 不判定 |
| 本条有 ≥10 个有效字符的文本 | 与 `farm.js` 的归一化口径一致；纯图/纯链接不参与 |
| `band === 'ignore'`（α 额外要求） | 已被隐藏的推文不需要 α 徽标（也不把它当参考） |
| 预算允许（裁决 §9.1） | 全局日额度 `budget.maxJevPerDay − day.jev > semantics.reserveForFiltering`（默认 50）**且**全局分钟窗口有余量，**且** `semantics.maxPerMinute/maxPerDay` 未耗尽；否则 `skipped += 1`、`reason = budget_exhausted` |

**每一条推文最多 1 次语义调用**；β 与 α 同时需要时**合并为同一次请求**（同一个 `state` 里含 `CANDIDATE`（β 候选）、`CANDIDATE_META` 与 `REFERENCES`（α 参考），`questions` 里同时含 `beta_c1..cN` 与 `alpha_majority`/`alpha_contrast`）。同一条推文并发只判一次（沿用现有的 `inflight` 去重）。

### 2.1 β 判定步骤

| 步 | 名称 | 输入 | 输出 | 失败降级 |
| --- | --- | --- | --- | --- |
| **B0** | 本地窗口 | 当前页面会话里最近 `beta.windowSize`（60）条已判定推文（含本条之前的所有判定） | 窗口列表 `[{id, handle, text, normText, threadId, farmKey, band}]` | 窗口空（首条）→ 0 候选，`beta=null`，不调用 |
| **B1** | 候选筛选（0 请求、纯本地） | 本条 `normText` 与窗口每条 | `candidates`：最多 `beta.maxCandidates`（6）条，按相似度降序 | 无候选 → 不调用、不计 `skipped`、不计 `calls`（无候选不是失败） |
| **B2** | 一次 Jev 批量调用 | `state`（§2.3 格式）+ `questions.beta_c1..cN`（noul，每条候选一问）；α 条件满足时同一请求追加 α 问题 | 每条候选一个 `noul ∈ [0,1]`；缺字段该候选作废 | 超时/HTTP 错误/答案残缺 → 全部候选作废，`beta=null`，`stats.semantics.errors += 1`；过滤结果不变 |
| **B3** | 阈值与择组 | 候选概率 + 本地相似度 | 取**概率最高且 ≥ `beta.threshold`（0.70）**的候选作为同组伙伴；并列时取组内 DOM 更早的那条为代表 | 全部 < 阈值 → `beta=null`；0.55–0.70 灰区 → 不折叠（保守），可在 `detail.semantics` 记录 `beta_gray` 便于调参 |
| **B4** | 组装字段 | 组内成员（含历史成员） | `groupKey`、`groupSize`、`similarity`、`kind`、`duplicateOf`、`folded` | 参数缺失一律 `null`（I-αβ.5） |
| **B5** | α 优先 | `alpha.hit` | `alpha.hit === true` → 本条 `beta.folded = false`（不同观点不被折叠掩盖）；`beta` 其余字段可保留 | — |

**候选入选规则（本地，防误伤的关键）**

```
normText = NFKC → 去零宽 → 小写 → 只留 CJK/日文假名/字母数字      （与 farm.js normalizeFarmText 同一套）
相似度 sim = 字符 3-gram 重叠系数 + 长度比护栏（0.5–2.0）           （与 farm.js farmSimilarity 同一套）

入选（任一）：
  a) sim ≥ 0.45                                  → 候选
  b) 同 threadId 且 sim ≥ 0.30                   → 候选（放宽，但不允许 0 相似度）
  c) 同农场簇（farmKey 相似度 ≥ minSimilarity）    → 候选
排除：本条或对方是「引用推文且有自己的正文（quotedText 非空 + text 非空）」、对方 band ≠ ignore、对方已 folded、
      任一侧 normText < 10 字符
```

> **已裁决（§9.2）**：同 threadId **不单独构成候选** —— 必须 `sim ≥ 0.30` 才放宽入选；其它路径仍要求 `sim ≥ 0.45`；同农场簇（`farmKey` 相似度 ≥ `minSimilarity`）维持合格。`sim < 0.30` 的同线程回复**不比较、不送模型**（对应 AC21）。

**`kind` 判定（本地启发式，不再多花一问）**

```
归一化文本完全相等                      → 'verbatim'
sim ≥ 0.70（或同农场簇且 sim ≥ 0.7）    → 'paraphrase'
其余（模型判定同一信息）                 → 'same_claim'
```

**`groupKey`**

`'bk_' + hash32(代表条目的归一化文本)`；同组共享，跨 Service Worker 重启不要求稳定（组是页面窗口概念）。

### 2.2 α 判定步骤

| 步 | 名称 | 输入 | 输出 | 失败降级 |
| --- | --- | --- | --- | --- |
| **A0** | 语境门槛 | `tweet.context`、`tweet.threadId`、`band` | 满足 `context === 'reply'`、`threadId` 非空、`band === 'ignore'` 才继续 | 非回复（`alpha.onlyInReplies = true`）→ `alpha=null`，`semantics.skipped += 1`（reason `not_a_reply`） |
| **A1** | 参考集合 | 同 `threadId`、本次会话已判定过的回复 | 最多 `alpha.maxReferences`（12）条；排除：自己、`band !== 'ignore'`、有效字符 <10、纯图/纯链接 | 可用条数 < `alpha.minReferences`（3）→ `alpha = null`、**不调用模型**、`skipped += 1`（reason `not_enough_references`） |
| **A2** | 一次 Jev 批量调用 | `state` 含 `TARGET:` + `REFERENCES:`（编号）；`questions.alpha_majority`（noul）+ `alpha_contrast`（score，2–4 级：0 无对比 / 1 轻微 / 2 明显 / 3 非常明显） | `majority ∈ [0,1]`、`contrast ∈ {0,1,2,3}` | 超时/错误/缺字段 → `alpha=null`、`errors += 1`；过滤不变 |
| **A3** | 阈值 | `majority`、`contrast` | `hit = majority ≥ alpha.threshold(0.70) && contrast ≥ 2`；`score = majority`（保留 3 位） | 不达线 → `alpha = null`（或 `hit:false` 的诊断对象，见 AC12 口径）；不标徽标 |
| **A4** | 组装 | 命中结果 + 参考条数 | `reason = 'diverges_from_majority'`（**本地固定枚举，不问模型**，省 token）、`referenceCount = 实际送入的参考条数`、`summary = '与评论区多数观点不同'` | 参考数 / 概率缺失 → 字段 `null`，不猜 |

**α 的 `summary` 为什么是本地拼接**：Jev 不是聊天模型，只回答 choice / score / noul（`classifier.js` 顶部约束），**不会返回自由文本**。所以 `summary` 必须由本地模板生成，不得要求模型给句子。

### 2.3 语义调用的一次请求长什么样（便于 mock 与真机验证）

- `state`（上限 4000 字符，与现有 `STATE_LIMIT` 一致）：

```
TARGET/CANDIDATE TEXT:
<本条正文，截断 ≤ 280 字符>

CANDIDATE_META:
id=1912...; handle=@commuter_a; local_similarity=0.86; kind_hint=paraphrase

CANDIDATE_META:
id=1912...; handle=@commuter_c; local_similarity=0.61; kind_hint=same_claim

REFERENCES:
[1] @reply_a: <评论正文，截断 ≤ 120 字符>
[2] @reply_b: ...
[3] @reply_c: ...
```

- `questions`：
  - `beta_c1..beta_cN`：noul ——「THIS post and the referred candidate in `CANDIDATE_META` express **the same information or the same claim**. Rephrasing, translation and paraphrase count as the same. Merely being on the same topic, or adding a new fact/source/opinion, does NOT count.」
  - `alpha_majority`：noul ——「The post in `TARGET/CANDIDATE TEXT` expresses a view that **clearly differs from the majority view of the comments in `REFERENCES`**, and it is a substantive opinion (not a question, not pure emotion, not spam).」
  - `alpha_contrast`：score（2–4 级）——「How clearly does the post's view differ from the majority view of the references? 0 = no comparison possible / 1 = slight / 2 = clear / 3 = very clear contrast.」
- 问题 id 不会发给模型，完整说明必须写在英文 instructions 里（沿用 `classifier.js` 的既有约束与英文口径）。
- 本轮 e2e 夹具与 mock 已按上述三段式（`TARGET/CANDIDATE`、`CANDIDATE_META`、`REFERENCES`）实现，`tools/live-check.js` 的真机样本也应照此构造，保证「脚本跑的就是线上那条流水线」。

### 2.4 与缓存的关系（易错点，必须实现对）

- **基础判定照旧缓存**（键 = 推文 id + 文案哈希 + 设置指纹）。
- **设置指纹必须包含 `settings.semantics`**，否则切换 α/β 开关后，已缓存的推文会继续返回旧的 `beta/alpha`（0.2.0 的「切换自动静音不生效」就是同一类 bug，见 `docs/DESIGN.md` §6.5）。
- **β/α 结果依赖页面上下文**（窗口里有哪些推文、参考评论区是哪几条），因此**不得把富化结果当作可跨页面复用的判定缓存**：同一推文在「有伙伴的页面」被折叠、在「只有它自己的页面」必须不折叠（AC18）。
- 推荐实现：基础判定进缓存；语义富化每次页面会话按当前窗口重算（可另设一个短 TTL 的**同页面**语义缓存，键含窗口/参考指纹）。

### 2.5 失败降级矩阵（超预算/模型不可用不得影响过滤结果）

| 情况 | `decision.beta` | `decision.alpha` | 过滤（band/动作） | 统计 / 现象 |
| --- | --- | --- | --- | --- |
| `semantics.enabled = false` | `null` | `null` | **与关闭前逐字段一致** | `calls` 不增；无新增网络请求 |
| `beta.enabled = false` | `null` | 照常 | 不变 | β 面板统计应保持不增 |
| `alpha.enabled = false` | 照常 | `null` | 不变 | — |
| 无 β 候选 | `null` | 照常 | 不变 | 不调用模型，不计 `skipped`/`errors` |
| α 参考 < `minReferences` | 照常 | `null` | 不变 | `skipped += 1`（`not_enough_references`）；不发请求 |
| 非回复 / `threadId` 为空 | 照常 | `null` | 不变 | `skipped += 1` |
| 超 `semantics.maxPerMinute/maxPerDay`，或全局日额度剩余 ≤ `reserveForFiltering`，或全局分钟窗口无余量 | `null` | `null` | 不变 | `skipped += 1`（`budget_exhausted`，保底口径见 §5.3/§9.1）；弹窗提示「语义预算已用完」 |
| 语义模型超时 / HTTP 4xx/5xx | `null` | `null` | 不变 | `errors += 1`；页面无异常；推文正常显示/隐藏 |
| 答案不合规（缺字段） | `null` | `null` | 不变 | `errors += 1`（或 `skipped`，实现二选一但要一致） |
| 页面已隐藏该推文（`band !== ignore`） | `null` | `null` | 不变 | 不消耗语义预算 |

---

## 3. 编号验收标准（AC1..AC21）

标记说明：
**【机制】**= 与模型运气无关的确定性行为，必须 100% 通过；
**【模型】**= 依赖真实 Jev 的判断质量，按「阈值口径」验收（概率不达线但方向正确 = 校准问题，不是 bug；方向相反或大面积误判 = bug）；
**【成本】**= 配额与 token 口径。

验收需要同时看三处：页面现象（`article` 的 DOM 属性与文案）、审计/统计（设置页统计区、弹窗、SW 调试对象）、以及（可选）`tools/verify-in-chrome.js` / `tools/live-check.js` 的输出。

### β（贝塔）

**AC1【机制】** 时间线里相邻两条**文字几乎一致**（只差 emoji/标点/大小写/零宽或同句重复）的推文：第一条完整显示，第二条只剩细条；细条文本包含 `与 @第一条作者 的内容相同`、`还有 1 条相似内容`、按钮 `展开`。`article.dataset.jevxBeta === '1'`。

**AC2【模型】** 两条**措辞不同但信息相同**的推文（例：中文原帖与它的英文翻译；或「今天在地铁上有人给老人让座，挺暖的」/「坐地铁时有人主动让老人让座，感觉很温暖」）：第二条被折叠；细条 tooltip 显示 `措辞不同、意思相同`；SW 侧该组 `kind = 'paraphrase'`（`verbatim` 只给归一化完全一致的组）。

**AC3【机制】** 组内 3 条相似推文：完整展示 1 条，另 2 条各为细条，细条计数文本为 `还有 2 条相似内容`（= `groupSize − 1`）；代表条目**不出现**折叠条。

**AC4【机制】** 点细条上的 `展开` → 该推文完整还原（子节点可见、细条保留但显示展开态），按钮变 `收起`，`article.dataset.jevxBetaExpanded === '1'`；再点 `收起` → 折回，该属性不再等于 `'1'`（删除或置 `'0'` 都可）；展开/收起不改变其它推文的隐藏条数与动作条数。

**AC5【机制】** 一组里只有一条时（同桌面上只有这一条重复内容）不显示任何 β 附着物（`beta === null`，无折叠条、无 `jevxBeta` 属性）。

**AC6【机制】** 代表规则：细条里的 `@` 指向**该组最早出现且完整展示**的那条；`beta.duplicateOf` 等于该推文 id；代表自己的 `beta.folded === false` 且 `duplicateOf === null`。

**AC7【机制】** 纯展示不变量：把 `semantics.enabled` 从开到关，同一批推文的 `band`、`reasons`、隐藏条数、账号动作条数**完全一致**；β 折叠**不计入**徽标「已过滤」计数、**不产生** `hidden` 审计事件、**不产生**任何静音/拉黑（演练与武装模式下都验证）。

**AC8【机制】** 没有相似候选的孤立普通推文：`calls` 不增加（0 次语义调用），`article` 上无 β/α 附着物；页面无脚本异常。

**AC9【机制】** 误伤护栏（逐条可观察）：引用并带自己评论的推文不被折叠；同一账号连发两条**不同**内容不被折叠；同一新闻事件的**不同**报道（措辞/事实/来源不同）不被折叠；长文与它的一句话摘要不被折叠；有效字符 <10 的「支持」「哈哈」不参与分组。

### α（阿尔法）

**AC10【模型】** 打开一条推文的详情页：3 条以上回复立场一致，其中 1 条回复明显表达不同观点。该回复显示徽标 `α · 与评论区多数观点不同`，`article.dataset.jevxAlpha === '1'`；推文**完整可见**、无隐藏条、无静音/拉黑；同页多数派回复**不出现**徽标。

**AC11【机制】** α 非目标：与多数一致的回复（即使情绪激烈/用词粗鲁）无徽标；单纯提问/求推荐无徽标；只有 2 条参考评论时不判定（`skipped` 增加、`calls` 不增加、`alphaHits` 不增加）。

**AC12【机制】** α 参考门槛：`referenceCount` 是实际参与对比的条数；参考不足时页面上没有任何 α 附着物（徽标不出现即通过；若实现返回 `alpha = {hit:false, referenceCount:n}` 作为诊断信息，也必须无徽标、无模型调用，且 `alphaHits` 不增）。

**AC13【机制】** α 纯展示：徽标不遮挡正文、不拦截点击、不改变推文的隐藏状态；悬停/读屏（`title` / `aria-label`）能看到 `referenceCount` 与 `score`；把 `alpha.enabled` 关掉后徽标消失、过滤结果不变。

**AC14【机制】** α 优先于折叠：同一条回复既被判「与多数不同」又落在某个相似组里时，`beta.folded === false`（不被折叠），徽标照常出现。

### 系统 / 成本 / 降级

**AC15【机制】** 合并调用与频次：一条推文最多 1 次语义调用；β 与 α 同时需要时是**同一个请求**（请求里同时含 `beta_c*` 与 `alpha_*` 问题）；同一推文并发只判一次。

**AC16【成本】** 超预算降级（裁决 §9.1、§9.3）：满足任一条件即停止语义调用、`beta = alpha = null`、`skipped += 1`、`reason = budget_exhausted`：
（a）`semantics.maxPerMinute` 或 `semantics.maxPerDay` 跑满（含把 `maxPerDay` 设为 0）；
（b）全局日额度剩余 `budget.maxJevPerDay − day.jev ≤ semantics.reserveForFiltering`（默认 50，保底给过滤）；
（c）全局分钟窗口无余量。
现象：不再有语义调用、没有 β 折叠、没有 α 徽标；六类过滤的 `band` 分布、隐藏条数、账号动作与关闭语义时**完全一致**（语义调用计入 `day.jev`，但永远不挤占过滤额度）；设置页/弹窗里 `skipped` 增加；弹窗提示 `语义预算已用完`。
**超预算时不做本地 `verbatim` 折叠**（`beta = null`）：完全相同的文本已由近似去重农场（≥2 个不同账号）处理成 `hide`，α/β 不再另设一套口径，避免两套机制打架。

**AC17【机制】** 模型失败降级：语义网关返回 500 / 超时 / 缺字段时：`beta = alpha = null`、推文正常显示或按过滤隐藏、`errors` 增加、页面无未捕获异常（Chrome 控制台无红色报错、审计无 `error` 事件）。

**AC18【机制】** 缓存与上下文：先开语义浏览（某条被折叠）→ 关闭语义并刷新页面 → 折叠与徽标消失，且这些推文显示判定来源为缓存（不重跑过滤模型）；只打开那条推文的详情页/新会话（组内只有它）→ 不再被折叠。

**AC19【成本】** 统计口径：设置页统计区与弹窗显示的 `β 折叠数 / α 标记数 / 语义调用数 / 预算跳过 / 调用失败` 与页面观察一致；字段缺失时显示 `0` 而不是 `undefined`。

**AC20【成本】** token 口径：语义调用单独计量（调用次数同时计入全局 `day.jev`，token 单独统计以便与过滤成本分开看）。典型时间线（100 条已判定推文、其中 5–12 条有候选/参考）语义调用 ≤ 12 次；单次批量调用 `input ≤ 3000 token`（见 §5 估算表）；把实测值记进 `docs/VERIFICATION.md`。

**AC21【机制】** 同线程无关回复不比较（裁决 §9.2）：同一条推文（同 `threadId`）下的两条**无关**回复（`localSimilarity < 0.30`）：`semantics.calls` 不增加（两者都不因对方而被送模型）、两条都完整可见、无 `beta` 字段；而 `localSimilarity ≥ 0.30` 的同线程相似回复照常进入候选并可能折叠。

### 验收优先级

- **P0（不通过就不能发版）**：AC1、AC3、AC4、AC5、AC6、AC7、AC8、AC9、AC11、AC12、AC13、AC14、AC15、AC16、AC17、AC18、AC21。
- **P1（发布后按实测校准）**：AC2（模型语义判别质量）、AC10（真实评论区的模型表现）、AC19、AC20。

---

## 4. 边界与误伤清单

| # | 场景 | β 期望 | α 期望 | 护栏 |
| --- | --- | --- | --- | --- |
| B1 | **翻译**（同一信息不同语言：中文原帖 + 英文翻译） | **折叠**（`kind = paraphrase`）：语义相同、无新增量 | 翻译本身不产生观点；若翻译的是一条与评论区多数不同的观点 → 可标 α | 本地跨语言相似度低 → 只能靠模型；模型不达阈值就不折叠（宁可漏折） |
| B2 | **引用（带自己评论）** | **不折叠**：引用者的评论是新增量 | 引用者的评论可作为 α 目标，按 A0 门槛判定 | 候选筛选直接排除「quotedText 非空 + text 非空」 |
| B3 | **纯引用（无自己文字）** | **默认不折叠**（转发是表态，不是复制粘贴重复）。P1 可加开关 `折叠无评论的引用`（默认关） | 不标（无自己的主张） | 默认保守；实测若噪声明显再讨论 |
| B4 | **转述 / 改写**（同一信息换说法、无新增量） | **折叠**（`paraphrase` / `same_claim`） | 视其观点是否与多数不同 | 需要模型过阈值 + 本地相似度 ≥0.45（同 threadId 时 ≥0.30） |
| B5 | **立场一致但措辞不同**（两条独立表述，各自有不同理由/细节） | **不折叠**：立场相同 ≠ 同一信息；没有共同的具体主张时连候选都进不去 | 都跟多数一致 → 不标 | 本地相似度门槛；模型问的是「同一信息/主张」，不是「同一立场」 |
| B6 | **同一新闻的不同报道**（不同媒体、不同事实/来源/角度） | **不折叠** | 与多数不同 → 可标 α | 模型问句里明确「添加新事实/来源/观点不算同一」；通稿级逐字相同才会落 `verbatim` |
| B7 | **反讽 / 阴阳怪气**（表面复制同一句，实际表达相反意思） | **不折叠** | 反讽本身不是 α（非目标：情绪/攻击性） | 带评论的引用排除；精确相同的讽刺复制落入 `verbatim` 时靠「可展开」可恢复——列为**已知风险**（§7.2 第 5 条） |
| B8 | **长文本 vs 一句话摘要** | **不折叠**：信息量不等 | 一句话口号不标 α（要求实质内容） | 长度比护栏 0.5–2.0；`alpha_contrast ≥ 2` |
| B9 | **同一账号连发不同内容** | **不折叠**（账号不是判据） | 若在回复区且观点不同 → 可标 α | — |
| B10 | **同一账号连发相同内容** | **折叠**（重复的是信息） | — | 与 B9 的区别只在「内容是否同一」 |
| B11 | **模板化广告（同一模板、不同产品）** | **不折叠为 β**（产品不同） | 不标 α（广告不是观点） | 归六类过滤 / 农场处理；`same_claim` 需模型过阈值 |
| B12 | **评论区大量「支持」类短语** | **不折叠**（有效字符 <10 不参与） | 不标 α | 与 `farm.js` `FARM_MIN_CHARS = 10` 同口径 |
| B13 | **只有 3 条参考、2:1 分歧** | — | **不标**：模型概率 + 显著度双门槛，避免 2:1 被当成「多数」 | 提高 `alpha.minReferences` 或 `alpha.threshold` 可再收紧 |
| B14 | **参考评论本身是被过滤的垃圾** | — | 参考集合排除 `band !== 'ignore'` 的条目 | 防止机器人刷屏把「多数」带偏 |
| B15 | **与多数不同但内容是错的** | — | **仍可标 α**（α 不判真假）；如若不希望如此，属于后续「事实核查」功能，不在本轮 | 文案里不许出现「正确/错误」暗示 |
| B16 | **评论区/回复动态变化** | — | 本次会话的第一判定为准；后续新评论不重判（每条最多 1 次语义调用） | **已知边界**（§7.2 第 4 条，本轮明确不修；README 的「已知限制」同步写明） |
| B17 | **纯图/纯链接推文（无正文）** | 不参与 | 不参与 | 与「只发图黄推」路径互不干扰 |
| B18 | **同一条推文被 X 虚拟列表回收重渲染** | 折叠状态需可重建（重新判定或保留 `dataset`），不得出现「折叠条重复叠加/点展开后又被折叠」 | 徽标不得重复叠加 | 复用现有 `signatureOf` / `resetArticle` 清理路径：重置时移除 β 条与 α 徽标 |

---

## 5. 成本模型

### 5.1 单次调用估算（token；CJK 按 ≈1 token/字，英文按 ≈1.3 token/词）

| 调用 | state 规模 | 问题说明 | 输出 | 估算（输入 / 输出） |
| --- | --- | --- | --- | --- |
| 现有过滤五问（参考） | 推文 ≤4000 字符 | 5 问英文 | ~40 | 实测 ≈600 / 40（`VERIFICATION.md` §5：23 次 14530 输入） |
| 现有预检单问（参考） | 同上 | 1 问 | ~12 | 实测 ≈90 / 12（`README` §2） |
| **β 批量（≤6 候选、无 α）** | 本条 ≤280 + 6×≤120 字符 ≈ 1000 字符 | 6 条 noul（每条 ≈90 英文词） | 6×~10 | **估 900–1600 / 50–90** |
| **α 单条（≤12 参考）** | 本条 ≤280 + 12×≤120 字符 ≈ 1700 字符 | 2 问（noul + score） | ~20 | **估 900–1800 / 20–40** |
| **β+α 合并（回复区典型：2–4 候选 + 3–5 参考）** | ≈1200–2400 字符 | 4–6 问 | ~40 | **估 1200–2200 / 40–80** |
| 时间线 100 条的语义总量 | 多数推文 0 候选 0 调用 | — | — | **估 5–12 次调用 ≈ 6k–20k 输入 token** |

> 这些是**估算**：`state` 上限沿用现有 4000 字符截断，真实值必须用 `tools/live-check.js` 打真实 Jev 记录（AC20）。语义调用的 token 建议在 live-check 里**单独统计**，不要和过滤调用混在一起。

### 5.2 默认配额（冻结）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `semantics.enabled` | `true` | 语义层总开关；关掉 = 0 新增请求 |
| `semantics.beta.enabled` / `alpha.enabled` | `true` / `true` | 分别可关；关一个不影响另一个 |
| `semantics.maxPerMinute` | `10` | 语义调用/分钟（同时占用全局分钟窗口 `budget.maxJevPerMinute`） |
| `semantics.maxPerDay` | `300` | 语义调用/天（同时计入全局 `day.jev`，受 `budget.maxJevPerDay` 约束） |
| `semantics.reserveForFiltering` | `50` | **内部保底**（裁决 §9.1）：全局日额度剩余必须 > 此值才允许语义调用；UI 不必暴露 |
| `semantics.beta.maxCandidates` | `6` | 单次批量最多问几个候选 |
| `semantics.beta.windowSize` | `60` | 本地窗口：最近多少条已判定推文参与候选筛选 |
| `semantics.alpha.maxReferences` | `12` | 单次对比最多参考评论数 |
| `semantics.alpha.minReferences` | `3` | 少于这个数不做 α 判定 |
| `semantics.beta.threshold` / `alpha.threshold` | `0.7` / `0.7` | 折叠 / 标记阈值（夹紧 0.3–1） |

### 5.3 预算口径与过滤保底（I-αβ.3，裁决 §9.1）

- **语义调用计入全局额度**：每次语义调用同时占用全局日额度（`day.jev += 1`）与全局分钟窗口，并额外受 `semantics.maxPerMinute/maxPerDay` 约束 —— 这样「总请求量」只有一个真相来源。
- **过滤保底（不允许语义挤占过滤）**：只有 `budget.maxJevPerDay − day.jev > semantics.reserveForFiltering`（默认 50）**且**全局分钟窗口有余量时才允许语义调用；否则跳过本轮语义，`beta = alpha = null`、`skipped += 1`、`reason = budget_exhausted`。
- **超预算行为**：立即停止语义调用（包含 `semantics.maxPerMinute/maxPerDay` 跑满与保底触发两种情况），**过滤结果逐字段不变**（AC16）；弹窗顶部提示 `语义预算已用完`；下一个自然分钟/日窗口自动恢复。
- **超预算不做本地兜底折叠**（裁决 §9.3）：不做 `verbatim` 本地折叠，`beta = null` —— 完全相同的文本已由近似去重农场（≥2 个不同账号）处理成 `hide`，避免两套口径打架。
- **与采样/白名单一致**：被 `prefilter.skip`（白名单、自己发的、超短无媒体、scope 关闭）的推文不发起也不计入语义调用，与过滤口径一致。

### 5.4 降本设计（已含在流程里）

1. 本地候选筛选先砍掉绝大多数推文：普通时间线里大多数推文 0 候选 → 0 调用。
2. β 与 α **合并成一次调用**（每推文上限 1 次）。
3. `kind` 与 `reason` 由本地启发式/枚举给出，不多花问题。
4. α 只在回复区（`onlyInReplies`）且参考充足时判定。
5. 窗口只保留最近 `windowSize` 条，候选上限 `maxCandidates`，参考上限 `maxReferences`。

---

## 6. 交互与文案清单（中文短语，UI/UX 直接用）

### 6.1 β 折叠条（内容脚本，`src/content`）

| 元素 | 文案 | 触发 | 备注 |
| --- | --- | --- | --- |
| 折叠条全文 | `与 @{代表账号} 的内容相同 · 还有 {groupSize − 1} 条相似内容` | `beta.folded === true` | 2 条组 → `… · 还有 1 条相似内容`；代表账号未知（代表不在当前 DOM）时用 `与 @{duplicateOf} 的内容相同`，SW 若能给 `duplicateOfHandle` 则直接显示 `@handle` |
| 按钮 | `展开` / 展开后 `收起` | 折叠条 | 真实 `<button>`、`aria-expanded`；`aria-label` = `展开被折叠的相似内容` / `重新折叠这条相似内容` |
| 类型标签 | `内容完全相同`（verbatim）/ `措辞不同、意思相同`（paraphrase）/ `表达同一个说法`（same_claim） | tooltip 内 | 仅解释用，不改行为；未知 kind → `相似内容` |
| tooltip | `{类型标签} · 相似度 {pct}% · 分组 {groupKey}` | hover/长按 | `pct = round(similarity×100)`；缺一项就少显示一项 |
| 展开后的文本 | `已展开 · {折叠条全文}` | 展开态 | 已实现；弱化样式，不遮挡正文 |
| 无障碍 | 文本与 `title`/`aria-label` 全用 `textContent` 写入 | — | 严禁 `innerHTML` 拼推文内容（沿用现有安全约束） |

**DOM 契约（Lead 的端到端会用）**：折叠时 `article.dataset.jevxBeta = '1'`；展开时 `article.dataset.jevxBetaExpanded = '1'`；折回时该属性**不再等于 `'1'`**（实现可删除或置 `'0'`，两种都接受）；`globalThis.__jevxContent.summary()` 增加 `betaFolded`。折叠条文本必须同时包含 `还有` 与 `相似`，按钮文本必须是 `展开`。

### 6.2 α 徽标（内容脚本）

| 元素 | 文案 | 触发 | 备注 |
| --- | --- | --- | --- |
| 徽标全文 | `α · {summary}`（当前 = `α · 与评论区多数观点不同`） | `alpha.hit === true` | 用**中性/正向**样式（建议 slate/蓝），禁止警告色、感叹号、红色；缺失 `summary` 时兜底 `与评论区多数观点不同` |
| tooltip / 读屏 | `{summary}（参照 {referenceCount} 条 · 分数 {score}）`；`aria-label` = `α {summary}，参照 {n} 条，分数 {score}` | hover / 读屏 | 已实现；分数保留 2 位小数 |
| 可点开说明（P1，可选） | `α 只做标记：这条回复与同一推文下已读取的 {referenceCount} 条评论的多数观点不同。不隐藏、不静音。` + `不再标记 α` | 点徽标 | **本轮未实现**；徽标本身保持不可点，避免遮挡/误触，说明走 `title`/`aria-label` 即可 |
| DOM 契约 | `article.dataset.jevxAlpha = '1'`；徽标文本包含 `α`；`summary()` 增加 `alphaMarked` | — | 徽标放在 article 内最前面的独立行，`pointer-events` 正常、不遮挡正文 |

### 6.3 设置页（`src/options`）

| 位置 | 文案 |
| --- | --- |
| 节标题 | `α / β 语义信息` |
| 说明 | `β（贝塔）：重复 / 类似 / 语义相同的信息折叠，只完整显示一次，可展开。α（阿尔法）：与评论区多数观点明显不同的特殊信息，只标记，不隐藏。两者都不影响隐藏与账号动作。` |
| 总开关 | `启用语义层（α / β）` |
| β 开关 | `折叠重复信息（β）` |
| β 数值 | `β 判定阈值`、`β 最多比较候选条数`、`β 观察窗口（最近条数）`、`时间线内折叠`、`回复区内折叠` |
| α 开关 | `标记特殊观点（α）`、`只在回复区判定 α` |
| α 数值 | `α 判定阈值`、`α 最少参考评论数`、`α 最多参考评论数` |
| 预算 | `每分钟语义调用上限`、`每天语义调用上限` |
| 统计标签 | `β 折叠条数`、`α 标记条数`、`语义调用次数`、`语义预算跳过`、`语义调用失败` |

### 6.4 弹窗（`src/popup`）

| 元素 | 文案 |
| --- | --- |
| 快捷开关 | `折叠重复信息（β）`、`标记特殊观点（α）` |
| 状态/统计格 | `β 折叠 {n} · α 标记 {n}` |
| 预算用完提示 | `语义预算已用完` |
| 调用失败提示 | `语义调用失败 {n} 次` |

### 6.5 审计与原因标签（新增，供排查）

| id | 中文标签 |
| --- | --- |
| `beta_folded` | `β：与已有内容语义相同，折叠显示` |
| `alpha_diverges` | `α：与评论区多数观点明显不同（参考 {n} 条）` |
| `semantics_budget_exhausted` | `语义预算已用完，本次未做 α/β 判定` |
| `semantics_model_error` | `语义调用失败，本次未做 α/β 判定` |
| `semantics_schema_invalid` | `语义回答不合规，本次未做 α/β 判定` |
| `semantics_not_enough_references` | `参考评论不足，未判定 α` |
| `semantics_no_candidate` | `没有相似候选，未判定 β` |

> β/α 只写这些**新**事件（`beta_folded` / `alpha_diverges`）；**不得**写 `hidden` 事件，不得改 `decision` 事件的既有字段。

---

## 7. 已知边界与实测项（裁决归档见 §9）

### 7.1 已裁决的接口项（归档，不再讨论）

1. **语义预算与过滤预算的关系** —— 已裁决：语义调用**计入**全局 `day.jev` 与全局分钟窗口，并受自身配额约束；全局必须给过滤留保底 `semantics.reserveForFiltering = 50`。口径见 §1.3 I-αβ.3、§5.3、AC16，裁决原文见 §9.1。
2. **同 threadId 的候选门槛** —— 已裁决：同 threadId 需 `localSimilarity ≥ 0.30`，其它路径 `≥ 0.45`，同农场簇维持合格。口径见 §2.1，验收见 AC21，裁决原文见 §9.2。
3. **超预算时不做本地 `verbatim` 折叠** —— 已裁决：维持 `beta = null`。理由：完全相同的文本已由近似去重农场（≥2 个不同账号）处理成 `hide`，避免两套机制口径打架。口径见 §5.3、AC16，裁决原文见 §9.3。

### 7.2 已知边界（本轮明确不修，按现状验收）

4. **α 是「会话内参考集合」的相对结论，后续加载的评论不会重判**（**已知边界**）：参考集合 = 同 `threadId` 下、扩展在**当前页面会话里已经判定过**的回复；且每条推文最多 1 次语义调用 → **页面加载更多评论后，先前已判定的那条不会重新判定**，α 结论可能滞后于「完整评论区」的真实多数。
   - 用户可见后果：打开详情页滚动加载时，先出现的回复可能暂时被标/不标 α；刷新页面、参考集合重建后按同一条规则重算。
   - 缓解（用户侧）：刷新页面；把 `alpha.minReferences` 调高让判定更保守。
   - **Lead 会在 `README.md`「已知限制」里同步写明这一条**（本规格不再要求实现重判；若以后要做，建议规则是「参考集变化 ≥2 条时允许重判一次，仍受预算约束」）。
5. **反讽的精确复制**（已知风险）：模型若把反讽当「同一信息」、本地相似度又很高，可能误折叠。缓解：折叠可一键展开；必要时提高 `beta.threshold`。

### 7.3 实测项（由 Lead 用 `tools/live-check.js` 在真实模型上覆盖）

6. **`threadId` 抽取口径**：`location.pathname` 的 `/status/<id>` 在 X 的**弹层（modal）**里打开状态页时可能仍是上一页路径 → `threadId` 可能取错；取不到时应不判 α（宁可不标，不能标错）。**由 Lead 的真机 live-check / 真实浏览器实测覆盖并记录结论。**
7. **真实模型对「同一信息」的跨语言/改写判别质量**：翻译对（B1）是本轮最不确定的一类。**由 Lead 用 `tools/live-check.js` 覆盖**：加 3–5 组翻译/改写正样本 + 3–5 组「同一事件不同报道」负样本，按阈值口径校准并把实测概率记进 `docs/VERIFICATION.md`。

### 7.4 其余待实测项（归属：真实浏览器验收）

8. **`kind` 启发式的准确率**：`verbatim/paraphrase/same_claim` 只影响文案，不影响折叠与否；如标签经常明显不符，先改本地阈值，不必动模型。
9. **缓存指纹必须包含 `settings.semantics`**（§2.4）。否则切开关不生效——这是 0.2.0 已犯过的同类错误（`docs/DESIGN.md` §6.5）。
10. **虚拟列表回收后的折叠状态**：X 会把 `article` 复用给别的推文。需实测「滚出视口再滚回」后折叠条不重复叠加、展开状态不串条。
11. **α 与六类过滤的交互**：被过滤隐藏的回复不做 α，也不进参考集合（B14）。需实测一个「评论区一半是机器人」的真实页面，确认 α 结论不被垃圾评论带偏。
12. **多语言/中英混合评论区**：α 的多数判定在混合语言下的稳定性未知。

---

## 8. 附录

### 8.1 字段总表（实现检查表）

| 字段 | 类型/取值 | 语义 | 谁写 | 可观察点 |
| --- | --- | --- | --- | --- |
| `beta.duplicateOf` | string \| null | 代表推文 id；代表自己为 null | SW | 折叠条 `@` 指向、审计 |
| `beta.duplicateOfHandle`（可选附加） | string \| null | 代表账号 handle，便于 UI 直接显示 `@handle` | SW | 折叠条文本 |
| `beta.groupKey` | `'bk_' + hash32` | 同组稳定键 | SW | 调试对象 |
| `beta.groupSize` | int ≥ 2 | 含自己在内的组员数 | SW | `还有 {n-1} 条相似内容` |
| `beta.similarity` | 0..1 | 与代表相似度（代表 = 1） | SW | tooltip `相似度 {pct}%` |
| `beta.kind` | `verbatim` / `paraphrase` / `same_claim` | 重复强度，仅显示 | SW | 类型标签 |
| `beta.folded` | bool | 内容脚本据此折叠 | SW | `jevxBeta`、折叠条 |
| `alpha.hit` | bool | 是否命中 α | SW | 徽标 |
| `alpha.score` | 0..1 | 「与多数不同」的模型概率 | SW | tooltip 显著度 |
| `alpha.reason` | `diverges_from_majority` | 本地枚举 | SW | 调试/审计 |
| `alpha.referenceCount` | int ≥ 0 | 实际参与对比的参考条数 | SW | tooltip、审计 |
| `alpha.summary` | string | 本地模板中文短句 | SW | 徽标文本 `α · {summary}` |
| `tweet.threadId` | string \| null | `/status/<rootId>` | content | α 分组的上下文键 |
| `settings.semantics.*` | 见 §1.5 | 开关/阈值/配额 | UI | 设置页、弹窗 |
| `stats.semantics.*` | `{calls,betaFolds,alphaHits,skipped,errors}` | 统计口径 | SW | 设置页统计、弹窗 |

### 8.2 不变量自查清单（开发自测 / Lead 复核）

- [ ] 关闭语义层后，`band`/`reasons`/`accountAction` 与开启时逐字段一致（构造同一批推文的对照，单测锁住）。
- [ ] `beta` / `alpha` 从不出现在 `reasons` / `reasonLabels` 里。
- [ ] `beta.folded` 为 true 时，内容脚本不写 `hidden` 事件、不计入徽标、不触发动作。
- [ ] α 命中时 `beta.folded === false`。
- [ ] 候选为 0 → 不调用模型；参考 < `minReferences` → 不调用模型。
- [ ] 超预算/模型异常 → `beta = alpha = null`，`skipped`/`errors` 各计其位，无未捕获异常。
- [ ] 每条推文最多 1 次语义调用（`calls` 增量 ≤ 1）。
- [ ] 语义调用计入全局 `day.jev` 与分钟窗口，并受 `semantics.reserveForFiltering`（默认 50）保底约束，绝不挤占过滤额度（AC16）。
- [ ] 同 threadId 的候选必须 `localSimilarity ≥ 0.30`（其它路径 `≥ 0.45`）；同线程无关回复不产生语义调用（AC21）。
- [ ] 设置指纹包含 `settings.semantics`。
- [ ] 语义调用失败时，过滤判定的返回不受影响（不延迟、不阻断）。

### 8.3 `reason` 枚举（α）

| 值 | 中文 | 何时用 |
| --- | --- | --- |
| `diverges_from_majority` | 与评论区多数观点不同 | 本轮唯一取值（默认） |

> 本轮不扩枚举。以后若要区分「反驳某条评论」「纠正事实错误」等，再走 Choice 问题新增值，不得在本地硬猜。

### 8.4 真实浏览器验收操作手册（用户可直接照做）

前置：加载扩展 → 设置页确认 `启用语义层（α / β）` 打开、阈值 0.7、`每天语义调用上限` ≥ 50；打开审计日志；保持演练模式（本功能与账号动作无关，演练/武装都可以）。

| 步骤 | 操作 | 对应 AC |
| --- | --- | --- |
| 1 | 找/造两条语义相同的推文（同一句话换个说法，或同一帖的中英版本），刷新时间线 → 只完整显示一条，另一条是 `还有 1 条相似内容` 的细条 | AC1、AC2、AC3、AC4、AC5、AC6 |
| 2 | 点细条 `展开` → 完整可见；点 `收起` → 折回 | AC4 |
| 3 | 设置页关掉 `启用语义层` → 刷新 → 折叠条消失、隐藏条数与徽标计数不变 | AC7、AC18 |
| 4 | 打开一条热门推文的详情页，找一条与多数回复观点明显不同的回复 → 出现 `α · 与评论区多数观点不同`；多数派回复无徽标 | AC10、AC13、AC14 |
| 5 | 打开一条只有 1–2 条回复的推文 → 无 α 徽标 | AC11、AC12 |
| 6 | 把 `每天语义调用上限` 设为 0 → 刷新 → 无折叠、无徽标，六类过滤照旧；统计里 `语义预算跳过` 增加 | AC16、AC19 |
| 7 | 正常浏览 10–15 分钟 → 设置页统计：语义调用次数、β 折叠数、α 标记数、失败数；抽查 3–5 条判断是否合理 | AC19、AC20 |

**验收口径（重要）**：
- **机制类 AC**（标记【机制】）不接受「大概对」：折叠条文案、计数、DOM 属性、不变量、降级行为必须精确符合。
- **模型类 AC**（【模型】）按「阈值口径」：模型概率未达 0.7 但方向正确且不是大面积误判 → 记为**校准问题**（调阈值或换样本），不算机制 bug；方向相反、把多数派标成 α、把无关内容折叠 → 计 bug。所有涉及真实模型的验收都应记录实际概率，方便事后调参。

### 8.5 变更记录

| 日期 | 变更 |
| --- | --- |
| 本轮 | 首版：α/β 定义、非目标、判定流程与降级、AC1..AC20、误伤清单、成本模型、文案清单 |
| 本轮（修订 1） | Lead 裁决三项接口问题（§9）：语义调用计入全局额度 + `reserveForFiltering` 保底（§1.3/§2.0/§2.5/§5.2/§5.3/AC16）；同 threadId 候选门槛 `sim ≥ 0.30`（§2.1，新增 AC21）；超预算不做本地 verbatim 折叠（§5.3/AC16）；α 参考集合滞后明确为**已知边界**（§7.2），真实模型实测项（跨语言/改写、threadId 取错）归 Lead 用 `tools/live-check.js` 覆盖（§7.3） |

---

## 9. 裁决记录（Lead 裁决，本规格据此执行）

> 以下三条由 Lead 在评审 AC1..AC20 后裁决，已写入上面的定义、流程、成本与 AC；如有冲突，以本节为准。

### 9.1 语义预算与过滤预算的关系（对应 I-αβ.3 / §5.3 / AC16）

- 语义调用**计入**全局 `budget.maxJevPerDay`（`day.jev`）与全局分钟窗口，同时受语义自身 `semantics.maxPerMinute/maxPerDay` 约束。
- 全局额度必须给过滤**留保底**：新增内部设置 `semantics.reserveForFiltering`（默认 `50`）。只在 `budget.maxJevPerDay − day.jev > reserveForFiltering` **且**全局分钟窗口有余量时才允许语义调用；否则 `beta = alpha = null`、`skipped += 1`、`reason = budget_exhausted`。
- **语义永远不挤占过滤额度**：保底额度只服务过滤判定；语义层不得让过滤判定因额度不足而降级。

### 9.2 同 threadId 的候选门槛（对应 §2.1 / AC21）

- 采用收紧口径：同 `threadId` 的候选需要 `localSimilarity ≥ 0.30`；其它路径（非同线程）需要 `localSimilarity ≥ 0.45`；同农场簇（`farmKey` 相似度 ≥ `minSimilarity`）维持合格。
- 后果：同一条推文下的两条无关回复**不比较、不送模型、不折叠**（AC21）；同线程但语义相近的回复仍会进入候选。

### 9.3 超预算不做本地 `verbatim` 折叠（对应 §5.3 / AC16）

- 维持 `beta = null`。
- 理由：**完全相同的文本已经由近似去重农场（`farm.js`，≥2 个不同账号）处理成 `hide`**；α/β 不再另设一套「零成本本地折叠」口径，避免两套机制互相打架、也避免用户看到两种不同的重复处理方式。

---

## 附：v0.4.2 追加的 β 类「低信息量附和」（Lead 追加，2026-09）

用户在验收后追加了一条需求：「情绪 认同 确定 之类的应该只显示一个」。
它落在 β 的语义范围内（**语义相同 = 都是没有实质内容的附和**），但**字符串毫不相似**，
所以原有的「3-gram 相似度选候选 + 模型判断」两条路径都抓不到。实现口径如下：

- **新增 β.kind 取值 `agreement`**（冻结接口的枚举扩展，字段名与结构不变）：
  `decision.beta = { duplicateOf, duplicateOfHandle, groupKey: 'ls:<threadId>:<class>', groupSize, similarity: 1, kind: 'agreement', lowSignal: 'emotion'|'agreement'|'confirmation', folded: true }`。
- **AC-β-LS1**：同一线程内同类附和 ≥2 条时，只保留最早的一条，其余折叠；折叠条文案为
  「与 @… 的同类附和（情绪/认同/确认） · 还有 N 条同类回复」，可展开。
- **AC-β-LS2**：判定**本地完成、0 次模型调用**；折叠不改变 `band` / `accountAction`（不变量 I1 不变）。
- **AC-β-LS3（保守性）**：`不同意` / `不确定` / `确实有问题` / `同意，但前提是数据要公开` / 疑问句 / 带数字或链接
  的回复**一律不折叠**；情绪、认同、确认三类之外不折叠。
- **AC-β-LS4（范围）**：只在回复区、同一 `threadId` 内归组；时间线不折叠（宁可少折叠）。
- **AC-β-LS5（可关闭）**：设置页 `semantics.beta.foldLowSignal` 关掉后，网络层与页面层新增产物均为 0。
- **AC-β-LS6**：开关打开时，被「过短无媒体」本地跳过的回复**照样折叠**（跳过的是判定与账号动作，不是展示整理）。

验证：`tests/lowSignal.test.js`（6 组）、`tests/pipeline.test.js`（3 组集成）、端到端场景 H（7 项断言，125/125）。