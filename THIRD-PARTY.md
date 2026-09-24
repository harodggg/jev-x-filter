# 第三方组件

本仓库以 **MIT** 发布（见 [LICENSE](LICENSE)）。随仓库一起分发的第三方代码只有一处：

## `src/vendor/jev-systemone/` — Jev 官方 TypeScript 客户端

- 包名 / 版本：`jev-systemone@0.1.1`
- 来源：npm registry tarball `https://registry.npmjs.org/jev-systemone/-/jev-systemone-0.1.1.tgz`
- tarball sha256：`5bec2dc754560a25810fa024cf66b343aba5994554d99ef54e53c04a4a5c4be2`
- 上游仓库：<https://github.com/SC0d3r/jev-systemone>
- 许可证：**MIT**（原样收录，见该目录下的 `LICENSE` 与 `VENDOR.md`）
- 收录方式：原样拷贝 tarball 中的 `dist/`，**未做任何修改**；没有构建步骤，也没有远程代码

之所以内置而不是让用户 `npm install`：MV3 的 CSP 禁止远程脚本，扩展的一切代码必须是包内的静态文件。
内置官方客户端可以保证 `POST {baseURL}/v1/systemone` 的请求体、重试与错误映射与上游实现完全一致，
而不是自己「照着文档猜」——`tests/jev-client.test.js` 会逐字段校验这条协议。

## 运行时不下载任何第三方代码

扩展不会在运行时加载任何外部脚本或样式（`npm run check` 会检查整包没有远程引用、
没有 `eval` / `new Function`、没有 `web_accessible_resources`）。
