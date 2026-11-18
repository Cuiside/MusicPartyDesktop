# MusicParty 独立回归测试（verifier 资产）

本目录是审计缺陷（`docs/BUGREPORT_2026-11-10_FULL.md`）的**可重复回归测试**。原始探针
（`docs/audit-2026-11-10/*.cjs`）只输出观察值；这里的每个 check 都带明确的
`expected` / `actual` / `pass` / `evidence` / `level`，并对**旧部署 JAR 基线**与**新 JAR**
运行同一套断言：旧 JAR 上指定断言必须 FAIL（证明测试能捕获缺陷），新 JAR 上应为 PASS。

## 环境要求

- Windows x64；Node v24（ESM）。
- Java 21+：默认 `C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot\bin\java.exe`。
- 桌面仓库依赖已安装（`node_modules`，含 `@stomp/stompjs`、`vue`、`axios`、`@electron/asar`）。
- 只使用合成 fixture 凭据（`MUSIC_U=valid-…`、`fixture-admin-…`），不接触真实账号/生产服务。

## 常用命令

```powershell
cd E:\example-desktop

# 旧部署 JAR 缺陷可复现基线（应出现预期 FAIL；JSON 写入 Delivery\verification\baseline-old-jar）
node tests/regression/run-all.mjs `
  --jar <old-baseline-jar> `
  --java "C:\Program Files\Microsoft\jdk-25.0.3.9-hotspot\bin\java.exe" `
  --label baseline-old-jar --strict

# 新 JAR 全量回归（服务器修复验收）
node tests/regression/run-all.mjs `
  --jar E:\example-delivery\server\server.jar `
  --label new-jar --strict

# 只跑部分 suite / 换隔离端口基准（默认 18848/18849/18850）
node tests/regression/run-all.mjs --jar <jar> --only s01,s10 --port-base 18948 --label smoke

# 桌面端旧代码基线（从 git 8b4df50… 导出旧 src/core/live + App.vue 做对照）
node tests/regression/run-all.mjs --jar <jar> --only desktop-pure --desktop-baseline --label desktop-old

# 分批跑完后合并（中断续跑/单 suite 复跑）
node tests/regression/merge-results.mjs --label baseline-old-jar --inputs baseline-old-jar,my-rerun-label
```

退出码：默认 0（便于基线采集）；`--strict` 时存在非 skip FAIL 返回 1。

## 结果与证据分级

每个结果 JSON 包含 `checks[]`，其中 `level` 表示证据等级：

- `real-jar` / `real-jar+restart`：真实 JAR + 隔离数据目录 + 合成上游 + 原始 STOMP/Wire 断言；
- `mock-http/upstream`：合成 HTTP 上游行为；
- `unit`：桌面纯函数（Node 直接 import `src/core/live/*`）；
- `static-source`：源码顺序/接线静态断言（D-01 watcher 顺序、D-06 ping 接线）；
- `real-electron`：真实 Electron（Vite dev + 未打补丁 App.vue，MP_EVAL 探针）；
- `packaged-artifact`：Windows 打包产物（exe/asar 资源清单/启动冒烟）。

结果写入：`E:\example-delivery\verification\<label>\suite-*.json`、`SUMMARY.json`、`PARTIAL.json`
（增量），并复制到 `E:\example-desktop\docs\verification\results-<label>.json`。

## 目录

| 文件 | 内容 |
|---|---|
| `run-all.mjs` | 入口：启动各 suite、汇总、落盘（`--jar/--java/--label/--only/--port-base/--strict/--list`） |
| `merge-results.mjs` | 多 label 结果合并 |
| `lib/env.mjs` | 路径/Java/JAR/端口（`--port-base`）/sha256/临时目录 |
| `lib/results.mjs` | check 收集器与结果写入 |
| `lib/http.mjs` | HTTP 助手、内部细节泄漏检测 |
| `lib/upstream.mjs` | 合成网易云上游（试听/null/空数组/404/非 HTTP/条目 code 等 fixture + 请求记录） |
| `lib/server.mjs` | Java 进程生命周期（隔离端口/临时数据目录/重启/日志/秘密扫描） |
| `lib/stomp.mjs` | 原始 STOMP 客户端（身份、ACK、ping/pong、广播秘密扫描） |
| `suites/s01-playable.mjs` | S-01 播放 URL 解析（完整/试听/null/空数组/404 回退/非 HTTP URL/业务失败） |
| `suites/s02-identity.mjs` | S-02 身份 v2 + O-02 `/api/config` capabilities、`/api/version` |
| `suites/s05-s06-cookie.mjs` | S-05/S-06 Cookie 验证持久化、无效值 400/422 保留旧值、秘密不泄漏 |
| `suites/s07-room-rest.mjs` | S-07 roomToken REST 保护（默认关闭兼容 + 显式开启 401/200） |
| `suites/s08-validation.mjs` | S-08 校验/405/未知 clear target 零副作用/无内部细节 |
| `suites/s09-ratelimit.mjs` | S-09 HTTP 429 + XFF 伪造不可绕过 + WS CONNECT 共享限流 |
| `suites/s10-d06-ping.mjs` | D-06 `/app/ping`→`/user/queue/pong` 单播 |
| `suites/s11-d15-ack.mjs` | D-15 command-ack 全 code（GUEST/LOCKED/COOLDOWN/QUEUE_FULL/DUPLICATE/INVALID/UPSTREAM/OK） |
| `suites/s12-d09-blank-admin.mjs` | D-09 空/空白/admin123 管理员密码拒绝 + adminConfigured=false |
| `suites/o03-cookie-normalization.mjs` | O-03 纯引号/引号包裹 Cookie 归一化 |
| `suites/s13-client-integration.mjs` | 新客户端 × 真实 JAR：能力探测、ACK、旧服务端降级、双服务器隔离（D-16） |
| `suites/desktop-pure.mjs` | 桌面纯函数/静态：D-01/02/06/08/12/13/15（可 `--desktop-baseline` 对照旧代码） |
| `../runtime/electron-runtime.mjs` | 真实 Electron 运行时：D-01 自动选中、D-13、D-14、D-15、D-02/D-12 |
| `../runtime/installer-smoke.mjs` | 安装包冒烟：exe SHA256/版本/asar 资源清单/无秘密/启动/设置页截图 |
| `tools/patch-ports.mjs` | 维护脚本（历史迁移用，可忽略） |

## 运行时 / 安装包脚本

```powershell
# 真实 Electron（Vite dev + electron，MP_EVAL 渲染探针）
node tests/runtime/electron-runtime.mjs --label runtime-electron

# 打包产物冒烟（--variant remote 或 local-server；--exe 指向 win-unpacked 内 exe）
node tests/runtime/installer-smoke.mjs `
  --exe "E:\example-desktop\release-new\win-unpacked\Music Party.exe" `
  --variant remote --label installer-remote
```

运行时脚本只使用本机隔离端口/合成数据，不修改业务源码；Electron 截图仅作辅助证据。
