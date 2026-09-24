# 内置第三方客户端：jev-systemone

- 包名 / 版本：`jev-systemone@0.1.1`
- 来源：npm registry tarball `https://registry.npmjs.org/jev-systemone/-/jev-systemone-0.1.1.tgz`
- tarball sha256：`5bec2dc754560a25810fa024cf66b343aba5994554d99ef54e53c04a4a5c4be2`
- 许可证：MIT（见同目录 `LICENSE`）
- 仓库：https://github.com/SC0d3r/jev-systemone
- 收录方式：原样拷贝 tarball 中的 `dist/`（未做任何修改），无构建步骤、无远程代码。

## 为什么不用 CDN

MV3 的 CSP 禁止远程脚本；扩展的一切代码必须是包内的静态文件。这里直接把官方客户端
的编译产物放到扩展里，保证 `POST {baseURL}/v1/systemone` 的请求体、重试与错误映射
与官方实现完全一致，而不是自己“照着文档猜”。

## 扩展侧如何使用

- Service Worker（`src/sw/background.js`）以 `type: "module"` 加载，直接
  `import { JevClient, choice, noul, score } from "../vendor/jev-systemone/dist/index.js"`。
- 内容脚本不用它：内容脚本只负责 DOM，所有网络与判定都在 Service Worker。
- 测试（`tests/jev-client.test.js`）用 `new JevClient({ fetch: mockFetch })` 注入假
  fetch，逐字节校验请求 URL/请求头/请求体，不需要联网。

## 上游文档中的关键事实（已核对源码）

| 事实 | 出处 |
| --- | --- |
| `POST {baseURL}{path}`，`path` 默认 `/v1/systemone` | `dist/client.js` `DEFAULT_SYSTEMONE_PATH` |
| 请求体 `{ state, questions, model }` | `dist/client.js` `systemOne()` |
| `Authorization: Bearer <key>`（有 key 时）+ `User-Agent: jev-systemone/0.1.1` | `dist/client.js` `request()` |
| 只有三种问题：`choice` / `score` / `noul` | `dist/validation.js`、`dist/helpers.js` |
| `choice` 返回 `choice/probabilities/confidence`，`score` 返回 `score/confidence/legend`，`noul` 只返回 `noul` | `dist/types.d.ts` |
| `choice` 选项上限 255；`score` 级别 2–10 | `dist/validation.js` |
| `state` 只能是**文本**（字符串/对象/数组），模型是纯文本的 | `dist/types.d.ts` `EntryType` |
| 浏览器环境（`window` + `document` 都存在）默认抛错，需要 `dangerouslyAllowBrowser` | `dist/client.js` `isBrowser()` |

最后两条对设计有两个硬约束，已体现在实现里：

1. **JEV 不能看图。** 色情图片判定只能靠本地像素启发式 + 可选的视觉模型适配器，
   JEV 负责文案与引流意图（见 `src/sw/media.js`、`src/sw/vision.js`）。
2. **MV3 Service Worker 里没有 `window`**，所以 `isBrowser()` 为 false，官方客户端可以
   直接在 SW 里跑；密钥也只存在 SW 可读的 `chrome.storage.local` 中，不进页面上下文。

## 在浏览器里实测出来的两条差异（已在 README / VERIFICATION 记录）

| 现象 | 说明 |
| --- | --- |
| `User-Agent` 设置无效 | 客户端会给每个请求加 `User-Agent: jev-systemone/0.1.1`，但 `User-Agent` 属于浏览器**受限请求头**，Chrome 会丢掉脚本设置的值，实际发出的是 Chrome 自己的 UA。服务端不要用 UA 识别客户端。（在 Node 下这一行是有效的。） |
| 动态 `import()` 不可用 | MV3 的 Service Worker 里禁止动态 import（`ServiceWorkerGlobalScope` 规范限制）。调用方必须**静态** import 这个包，不能 `await import(...)`。这一条被端到端测试抓出来过。 |
