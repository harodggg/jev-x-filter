# 设计说明

本文记录「为什么这样设计」。使用说明见 [README](../README.md)。

> v0.3.0 起这是**信息过滤器**：判定主干是 Jev 给出的**类别**（`src/sw/categories.js` 单点定义），
> 类别是否「可动账号」也在那里声明 —— 色情引流、诈骗、广告导流可以，标题党、低质、擦边诱饵不行。

## 1. 为什么是扩展 + Jev，而不是别的形态

| 方案 | 为什么不选 |
| --- | --- |
| 油猴脚本 | 能跑，但 API Key 会落在页面上下文，任何页面脚本都能读到；也不好做预算、审计、黑名单持久化 |
| 调 X 私有 GraphQL/API 自动拉黑 | 需要 cookie/`ct0`/bearer，属于自动化滥用风险面，且 X 改版即坏；本扩展坚持「只点界面」 |
| 纯关键词黑名单 | 黄推话术天天换（换字、拼音、表情、纯图），维护成本无限；本地正则只用来**省调用**，不用来下结论 |
| 纯云端判定服务 | 需要自建后端；Jev 的价值正是把「判定」变成一次类型化调用，而不是让你再写一个模型服务 |
| 用 Jev 判图 | 不可能：Jev 的 `state` 只能是文本（官方 `EntryType` 定义），它是纯文本决策模型 |

结论：**浏览器扩展做 DOM 与执行**，**Service Worker 做唯一的网络出口与判定**，**Jev 做文本判定**，
**本地像素启发式做图片信号**，**可选视觉模型**补图片本体。

## 1.5 召回策略：为什么必须有「模型先行」这一层

早期设计是「预筛命中才调用模型」，成本很低，但把**词表变成了召回上限**：真实黄推不断换写法
（`比我好看的没我骚🔧👏`、把引流写进显示名、拉丁字母替代 `约p`），任何白盒正则都会漏，
而漏掉的那些**模型一次都没看到**。用户拿两张真站截图证明了这一点，两张都是 `score=0`。

所以判定分成两条入口：

| 入口 | 触发条件 | 问法 | 输出 |
| --- | --- | --- | --- |
| 完整判定 | 预筛命中（强/两条弱特征）、图片可疑、视觉模型命中 | 五问（category / adult / solicitation / deceptive / severity） | 可到 `block` |
| 预检 | 上述都没命中，且 `triage.enabled` 且未超预算/被采样 | 单问 `bait`（机器人式成人诱饵原型） | 最多 `review`（隐藏待确认） |

预检命中后有两档：≥`baitEscalate` 再补一次完整四问（保证真露骨的黄推仍能走到 `block`），
≥`baitReview` 直接隐藏成待确认。**预检永不触发账号动作**，账号动作仍然只认四问的强类别 + 双闸门（I1）。

代价与旋钮：预检 ≈ 90 token 输入 / 12 token 输出（约四问的 1/4）；
`triage.sampleRate`、`triage.maxPerMinute`、`triage.maxPerDay` 控制总量；关掉 `triage.enabled`
就回到 0 请求模式。真实网关实测：骚式自夸 0.83，对照组 ≤0.18，阈值 0.70 余量充足。

不依赖词表的本地信号有四个（外加一个对抗手段）：

- **乱码账号名**：元音比例 <0.22 或连续辅音 ≥5（`yrmyzhcxvlkzpu`），只算 +1 弱特征。
- **显示名自身即色情引流**（`strongNameHit` → 最多 `review`）。
- **去符号匹配**（`stripSymbols`）：规则同时对原文与「删掉 emoji/符号/空白后的密集文本」匹配，
  用来对抗「关键字中间插 emoji」的规避（真站：`处🐕男` 实际写的是 `处男`）。
  弱特征还按「显示名 / 正文」分开计分 —— 同一句黑话出现在两处是两个独立信号。
- **文案农场**（`src/sw/farm.js`）：同一段（**近似**，3-gram 重叠系数 ≥0.8）无实质内容的话被
  ≥2 个不同账号在 30 分钟内复制 → `hide`；≥3 个账号时结构证据本身足够，不再要求内容侧信号。
  近似而不是精确相等是被真站样本逼出来的：农场账号会在同一句里各插不同垃圾字符。
  它是对「单条内容谁都拿不准」的补刀：真站样本单条诱饵概率只有 0.47–0.54，凑够账号数就成立。
  归一只保留中文/字母数字（换 emoji、标点、大小写无效），短于 10 个有效字符不参与。
  命中时流水线返回 `farm`，内容脚本按同一归一化键把**更早出现、当时判放行**的那几条一并隐藏（纯展示层，
  不产生账号动作）—— 因为先出现的两条在判定时农场还不成立，缓存里不会自己变。

## 2. 分层与依赖方向

```
content/  ──(chrome.runtime 消息)──▶  sw/background.js ──▶ sw/pipeline.js
   ▲                                     │                    │
   └── 只认「归一化推文对象」与「判定结果」  │                    ├─ prefilter.js（纯）
                                          │                    ├─ classifier.js ─▶ vendor/jev-systemone（协议）
                                          │                    ├─ gate.js（纯）
                                          │                    ├─ media.js（纯像素 + SW 运行时）
                                          │                    ├─ vision.js（可选）
                                          │                    ├─ blocklist.js（纯）
                                          │                    └─ audit.js（缓冲 + webhook）
                                          └─ settings.js / util.js（纯 + chrome.storage 包装）
```

依赖规则（有意约束）：

- `pipeline` 不认识 `chrome`：所有外部能力（Jev 客户端、图片分析、视觉模型、审计、时钟）都是注入的，
  因此它能在 Node 里跑完整端到端单测。
- `gate` / `prefilter` / `blocklist` / `media` 的像素部分 / `util` 是**纯函数**，没有 DOM 也没有网络。
- `content/*` 不判定、不联网、不持有密钥；`sw/*` 不碰 DOM。
- 内容脚本是传统脚本（不能有 `import/export`），SW 是 ES module 并直接 import 官方客户端。

## 3. 消息协议（content ↔ sw）

| type | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `JEVX_DECIDE` | →sw | `{tweet}` | 返回 `{ok, decision}`，同一推文并发只算一次 |
| `JEVX_GET_SETTINGS` | →sw | — | 内容脚本启动时读一次 |
| `JEVX_SET_SETTINGS` | →sw | `{patch, replace?}` | 白名单合并、夹紧、广播 `JEVX_SETTINGS_CHANGED` |
| `JEVX_GET_STATE` | →sw | — | 设置页/弹窗用：设置 + API 状态 + 统计 + 黑名单统计 + 预算 + 最近审计 |
| `JEVX_TEST_CONNECTION` | →sw | `{text}` | 用样例文案打一次真实 Jev 调用（设置页「测试连接」） |
| `JEVX_AUDIT_EVENT` | →sw | `{event}` | 内容脚本上报 hidden / action / action_failed / action_planned / shown |
| `JEVX_BLOCKLIST_IMPORT/EXPORT/REMOVE/CLEAR/GET` | →sw | — | 黑名单管理 |
| `JEVX_WHITELIST_ADD/REMOVE` | →sw | `{handle?, keyword?}` | 误判反馈 |
| `JEVX_CLEAR_CACHE` | →sw | — | 清空判定缓存 |
| `JEVX_BADGE` | →sw | `{count}` | SW 用 `sender.tab.id` 设置徽标 |

`decision` 的形状（内容脚本与审计共用）：

```js
{
  band: 'block' | 'hide' | 'review' | 'ignore',
  reasons: ['adult_solicitation_high_confidence', 'off_platform_solicitation'],
  reasonLabels: ['模型高置信度判定为色情引流/交易', '站外引流（Telegram/微信/外链）'],
  source: 'jev' | 'local' | 'cache' | 'disabled',
  skip: null | 'whitelisted_handle' | 'too_short_no_media' | ...,
  detail: { adult, solicitation, category, categoryConfidence, severity, prefilterScore, mediaSkinRatio, media: [...], vision },
  accountAction: { kind: 'none'|'mute'|'block'|'both', execute: boolean, dryRun: boolean, reason: 'dry_run'|'armed'|'budget_exhausted'|... },
  prefilter: { score, reasons, newsContext },
  tweetId, handle, latencyMs
}
```

## 4. 存储键

| key | 内容 | 写入者 |
| --- | --- | --- |
| `jevx.settings` | 完整设置对象（schema 1），见 `settings.js` | 设置页/弹窗 |
| `jevx.blocklist` | `{schema:'jevx.blocklist', version:1, entries[], whitelist{}}` | SW |
| `jevx.stats` | 累计统计（每 5 分钟 alarm 落盘） | SW |
| `jevx.auditLog` | 每小时把内存审计缓冲并入（上限 `audit.logLimit`） | SW |

设置合并是**白名单合并**（`mergeKnown`）：只接受默认结构里已有的字段，其余丢弃；数值一律夹紧；
`hideNoul ≤ blockNoul`、`hideConfidence ≤ blockConfidence` 强制成立。目的：被篡改的、旧版本的、
手工导入的设置都不可能注入未知字段或产生非法阈值。

## 5. Jev 调用约定（与官方客户端逐字节一致）

```
POST {baseURL}{path}            path 默认 /v1/systemone
Accept: application/json
Authorization: Bearer <key>     （Zen 免费档可省略）
Content-Type: application/json
User-Agent: jev-systemone/0.1.1   ← 浏览器是受限请求头，会被 Chrome 丢掉（见下）

{ "state": "...", "questions": { "adult": {...}, "category": {...}, ... }, "model": "jev-1.13-free" }
```

- 客户端直接使用 `src/vendor/jev-systemone/dist`（MIT，原样收录，见 `VENDOR.md`），
  不自己「照文档猜」请求体；`tests/jev-client.test.js` 注入了假 `fetch` 逐字节校验上面这些字段。
- 重试、超时、错误映射（401 → `AuthenticationError`、429 → `RateLimitError`…）都用官方实现。
- **平台限制**：`User-Agent` 属于浏览器受限请求头，Chrome 会忽略脚本设置的值。所以服务端
  不要用 UA 识别客户端；端到端测试把这行为显式断言下来，避免以后误以为是我们发的。
- **MV3 限制**：Service Worker 里禁止动态 `import()`（`ServiceWorkerGlobalScope` 不允许）。
  一切模块都必须静态 import —— 这个坑被端到端测试抓出来过。

## 6. 判定不变量（判定的「宪法」）

- **显示名向量**：`strongNameHit`（显示名命中「本身即色情」的强特征）最多把判定拉到 `review`，
  绝不升级为 `block`；作者解析失败（`handle` 为空）时 `planAccountAction` 直接返回
  `unknown_handle`，不做不可逆动作。
- **I0 类别开关约束所有隐藏路径**：关掉某一类（如「色情」）后，该类别的模型判定**与兜底路径**
  （成人概率、肤色、视觉模型、显示名引流）一律不再隐藏 —— 有单测逐条锁住。
- **I1 账号动作的唯一来源**：`band === 'block'`，而 `block` 必须有 Jev 的**可动账号类别** + 闸门
  （单条 0.90 双闸门，或「双确认」：两个互相独立的 Noul 同时 ≥0.80 且类别置信度 ≥0.95）。
  其余信号（预筛、肤色、视觉模型、降级）最多到 `hide`/`review`。
  `tests/gate.test.js` 逐条锁住：仅图片信号 → 不放行也不 block；仅预筛 → 放行；视觉模型单独 → hide。
- **I2 不确定就降级**：`0.5` 附近的答案不会被凑成高置信度；模型不可用时，有本地信号才 `review`，
  否则放行（避免一次接口抖动把整条时间线盖掉）。
- **I1b 预检/农场不拉黑**：`bait` 概率再高（哪怕 1.0）也只到 `review`；农场命中只到 `hide`。
  两者都是召回手段，不是账号动作依据。
- **I1c 隐藏档静音是显式选择**：`action.muteOnHide` 打开后，`hide` 档账号会被静音
  （`planAccountAction` 里 `hide` 档强制只取 `mute`，永不 `block`）；`review` 档任何情况下都不动账号。
- **I3 可解释**：每个档位都带 `reasons` 与中文标签；`planAccountAction` 明确写出
  `dry_run` / `armed` / `budget_exhausted` / `no_action_configured` / `band_below_block`。

## 6.5 判定缓存与设置指纹

缓存键 = 推文 id/文案哈希 + **设置指纹**。指纹必须包含**所有会改变判定结果的配置**：
阈值、`action`（含 autoMute/autoBlock/muteOnHide/dryRun）、`media`、`scope`、`whitelist`、
`triage`、`farm`、以及影响「预算是否够」的调用配额。

0.1.0 只放了 `hide`/`dryRun`，于是「在弹窗里打开自动静音」对已缓存的推文无效（仍按旧动作执行）。
这个 bug 是端到端场景 D 抓出来的，现在有单测锁住：改动作配置必须导致缓存未命中并重新判定。

## 7. 成本与配额

| 配额 | 默认 | 作用 |
| --- | --- | --- |
| `triage.maxPerMinute` / `maxPerDay` / `sampleRate` | 20 / 600 / 1 | 预检总量控制；关掉 `triage.enabled` 即 0 请求模式 |
| `farm.windowMs` / `minAccounts` | 30 分钟 / 2 | 农场判定窗口与账号数阈值 |
| `maxJevPerMinute` / `maxJevPerDay` | 30 / 800 | 超限 → 降级 `review`（有本地信号）或放行；真实模型实测 0.36–1.3 s/条，8 条样本 6133 输入 token |
| `maxMediaPerMinute` | 60 | 图片分析限流 |
| `concurrency` | 3 | 流水线并发（内容脚本侧还有 IntersectionObserver 与去抖） |
| `cacheTtlMs` / `cacheMaxEntries` | 6 小时 / 2000 | LRU，键含阈值指纹 |
| `maxActionsPerHour` / `maxActionsPerDay` | 20 / 100 | **只对真正执行的动作计数**，演练不占额度 |

## 8. 内容脚本的 DOM 策略

- **虚拟列表垃圾回收**：X 会把 `cellInnerDiv`/`article` 复用给别的推文。所以每个元素上记
  「内容签名 + epoch」，签名只取作者与文案节点（**不含我们注入的判定条**），两者一致才跳过；
  签名变了就先还原再重判。若签名包含整段 `textContent`，隐藏动作本身会抖动签名，形成自我循环
  （这正是端到端动作日志抓到的重复动作）。
- **动作幂等**：`acted` 集合按 `handle:kind` 去重，DOM 复渲染不会重复静音同一账号；失败则允许重试。
- **菜单串行**：菜单是页面级浮层，`enqueueAction` 把动作排成单链，避免两条推文抢菜单。
- **Escape 目标**：派发给 `document.activeElement`（真实 X 上派发给 `document` 关不掉菜单）。
- **确认框硬化**：点击前快照已存在的 `confirmationSheetConfirm`，只点新出现且文案匹配的那个
  （X 会把这个 testid 复用到别的弹窗）。
- **语言无关优先**：拉黑用 `[data-testid="block"]`；静音没有 testid，只能按文案匹配，且先排除
  `Unmute/Unblock/取消静音` 反义项。
- **纯图形态**：`mediaBlocked && shortWithMedia` → `review`（隐藏成待确认，不动作）。
  这是真实模型验证逼出来的：Jev 只能读文本，纯图片黄推的文案概率必然很低（实测 0.21），
  所以「只发图/纯链接形态 + 图片极可能裸露」是唯一可用证据；`mediaBlockedRatio` 默认 0.70，
  因为 0.62 会把泳装照也纳入「极可能裸露」。
- **成本控制**：MutationObserver 先做「相关性过滤」（新增节点里有没有 `data-testid`），
  再做 350ms 去抖；2.5s 兜底巡检覆盖「节点原地换内容」的情况（多个活跃项目都不使用
  IntersectionObserver 做成本控制，但这里用它来限定「只分析视口内推文」，是刻意的额外约束）。

## 9. UI 设计取舍

- 判定条替代整条推文：保留 `<article>` 本体、只藏子节点，滚动与虚拟列表不会错位；
  判定条给出概率与原因，并提供「显示 / 误判 / 立即动作」三个出口 —— 误判反馈直接写白名单，
  形成闭环。
- 设置页 44 个字段全部用 `data-path` 声明式绑定，新增配置项不需要改 JS。
- 破坏性能力（拉黑）默认关闭 + 演练模式默认开启，并把「本应执行」写进审计日志与弹窗，
  让用户在武装前有可核对的证据链。

## 10. 扩展点

- 换判定模型：只改 `src/sw/classifier.js`（问题集）与 `pipeline` 的 `jev` 注入；
  阈值表在 `settings.js`。
- 换/加图片判定：`src/sw/media.js` 的 `analyzeImageUrl` 或 `src/sw/vision.js`。
- 换执行方式（例如自建审核流水线）：`accountAction` 是纯数据，内容脚本的执行器可替换。
- 加审计后端：`src/sw/audit.js` 的 webhook，或直接消费 `JEVX_AUDIT_EVENT`。
