# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号与 package.json 一致。**本仓无 git 历史**（目录未 init 仓库），0.1.0 之前的演进无从考证，从 0.1.0 基线条目起记录；当前 package.json 版本为 0.2.0（0.1.0 → 0.2.0 的中间改动无日志可依）。

## [Unreleased]

### Added

- 工程化闸门：新增 GitHub Actions CI（`.github/workflows/ci.yml`，push main / pull_request 触发，concurrency 取消旧跑，contents: read）；步骤为 checkout → pnpm 11.23.0 → Node 22 → `pnpm install --frozen-lockfile` → `pnpm check`（typecheck + build）→ `pnpm test` → `node scripts/verify-package.mjs`（单测 import `lib/index.js`，置于 build 之后）。
- 新增 `scripts/verify-package.mjs`（零依赖）：files 白名单存在性、`lib/index.js` 产物探针（`sources.register(` 与 kind 名子串）、`lib/client.js` 非空、`cordis.patch.yml` id 与包名一致、locale 双语顶层 key 一致、`icon.svg`、`dsh.compatibility`。
- package.json 新增 `test` script（`node --test test/`）与 `dsh.compatibility` 兼容性声明（dsh 0.2.2-rc.1）。
- 新增 `src/dedup.ts`：入站事件持久去重（每账号一个 seen 文件，上限 1000 条，串行 + tmp + rename 原子写，跨重启）。stream.ts 管线入口查 `seenHas`、`source.receive` 成功后 `seenOrAdd` 落盘（at-least-once：宁重复不丢失，重复由引擎 trigger.id 幂等兜底），消费进程重连重订阅的重放不再重复派发。
- 新增 `src/failure-log.ts`：出站发送失败 JSONL 记录（`~/.local/state/dsh-superagent-dws/send-failures.jsonl`，上限 200 行，字段 `{at, channelKey, kind, error≤300字}`，无凭据；写失败不影响主流程）。接入 `channel.send` catch 路径，先记日志再原样 throw。
- 新增 `test/` 单测体系（node:test + node:assert，零网络零 CLI，跑在 build 后）：DwsConfigSchema 默认/拒绝、stream.ts NDJSON 信封解析纯函数（extractBusiness/textOf/isoTime/richTextOf/collectMediaCodes/toTrigger 最小导出，行为未改）、login-session 纯状态转移（spawn/listProfiles 依赖注入）、dedup、failure-log。

## [0.1.0] - 基线（无 git 历史，日期无从考证）

### Added

- dws 个人身份钉钉 Source：每账号一个 `dws event consume` 进程（NDJSON 三事件键：@提及/单聊/群全量），信封解析归一为 Trigger（@ 与群投递合并、自消息抑制、白名单群本地过滤），`dws chat message send` 个人身份出站。
- 面板登录/安装面：设备流登录会话（`dws auth login --device --no-browser`，新 profile diff 判完成）、dws CLI 静默安装（npmmirror → npm 官方）、/dws/api 同源路由与 client bundle「钉钉登录」页。
- 引擎接线：scope 准入（账号行 + 群白名单 + mention）、threadContext.read 经 `dws chat message list` 读会话历史、媒体标记 `[dws-media:ID]` 与按需下载注入。
