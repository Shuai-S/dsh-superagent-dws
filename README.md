# dsh-superagent-dws

dsh-superagent 的钉钉「个人身份」Source：复用本机 [dws CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 已登录的钉钉账号（OAuth 登录态，凭据只留在 dws，本插件永不接触），把「你」的事件流变成工作候选：

- `user_im_message_receive_at` — 你在任意群被 @ 的消息（无需登记群）
- `user_im_message_receive_o2o_all` — 你的单聊消息（按账号开关）
- `user_im_message_receive_group_all` — 所有群消息（仅「接收的群」白名单内的群进入引擎，其余在插件进程内丢弃）

回复以你的身份经 dws 发出，默认带 AI 角标；**优先引用回复**（`chat message reply`，`--uuid` 幂等），事件负载缺少原发送者 openDingTalkId 时自动回退为直发（`chat message send`，`--idempotency-key` 幂等）。

## 前置条件

- 本机安装 dws CLI 并完成 `dws auth login`
- 多账号：`dws profile list` 查看 `corpId:userId`，填入「钉钉账号」的 Profile 列；留空表示当前登录账号（最多一行留空）

## 官方约束（决定了架构）

同一账号同时只能有一个事件消费者：并发第二个 `dws event consume` 会被服务端拒绝（`SYSTEM_ERROR: subscribeUser failed`，2026-11-09 实测）。因此本插件**每账号恰好一个 consume 进程**，三个事件 key 合并在同一次调用里（三个 key 均无规则参数，可共存，dry-run 实证），群按白名单在插件本地过滤。

隐私提示：`user_im_message_receive_group_all` 会把你所有群的消息流经本插件进程；白名单之外的群在进程内解析后立即丢弃，不进引擎。

## 配置

| 字段 | 说明 |
| --- | --- |
| accounts[].profile | `corpId:userId`；留空 = 当前登录 |
| accounts[].directMessages | 接收单聊（默认开） |
| accounts[].aiTag | 回复带 AI 角标（默认开） |
| groups[].account | 所属账号的 profile 原文；留空 = 默认账号 |
| groups[].openConversationId | 会话 ID（cid 开头；面板带 choose/refresh 元数据，引擎支持时可选群） |
| coalesceMs（高级） | 同一消息经 at/group 两路到达的合并窗口（默认 2000ms） |
| readPageSize（高级） | 智能体读会话历史每页条数（默认 20，上限 50） |
| dwsBinary（高级） | dws 命令名或绝对路径（默认 `dws`） |

## 面板登录与静默安装（M1–M3）

- **M1 健康码**：dws 缺失/未登录不再笼统报错——`dwsStream` 给出精确指引（「dws CLI 未安装，正在静默安装…」/「dws 未登录：…」）；未登录时不拉起 consume，避免 subscribeUser 报错退避循环。
- **M3 静默安装**：本机没有 dws 时，watcher 按 npmmirror → npm 官方顺序静默执行 `npm i -g dingtalk-workspace-cli@latest`（每次尝试审计进引擎日志，失败退避 + 每 boot 最多 3 轮），装完自动 `--version` 校验并继续登录流程；面板「钉钉登录」页也可手动触发安装。
- **M2 面板登录**：侧栏新增「钉钉登录」页（client bundle）：列出已登录账号；「登录新账号（设备流）」→ 展示 user_code + 授权链接 → 完成后列出新 profile → 一键复制 Profile，粘贴进 设置→来源→钉钉个人（dws）→钉钉账号 的 Profile 列。凭据由 dws CLI 管理（macOS 钥匙串），插件与面板不接触任何 token。
- 路由：`/dws/api/*`（引擎面板同源闸门：Host loopback + `x-orchestrator-request: 1` + Origin 同源）。

## P2 能力

- **引用回复**：有原消息 openDingTalkId 时走 `chat message reply`（引用原消息），否则回退 `chat message send`
- **会话历史回读**：评估阶段经 `chat message list`（newer 方向，从触发消息时间起 readPageSize 条）读取 thread 上下文
- **媒体标记与下载**：事件负载出现 mediaId/downloadCode 候选时嵌入 `[dws-media:ID]` 标记（上限 5 个）；智能体可经 `chat message download-media` 下载图片（png/jpeg/gif/webp，魔数校验）
- **群名刷新**：refreshLabels 经 `chat +chat-list` 拉取已加入群名，存入 source KV 供面板显示
- **执行器环境变量**：`DSH_SUPERAGENT_DWS_ACCOUNT` / `DSH_SUPERAGENT_DWS_CHAT`

## 设计事实与实测记录（2026-11-09，dws v1.0.64）

- `dws event consume user_im_message_receive_at user_im_message_receive_o2o_all user_im_message_receive_group_all --dry-run` → 三个订阅一次接受
- 同账号并发第二个 consume → 服务端拒绝（subscribeUser failed）
- stderr 就绪行 `[event] ready`（与官方 feishu 源的 lark-cli 判定同款）
- `dws contact user get-self` 返回 `result[0].orgEmployeeModel.userId`，与 profile userId 同域 → 自消息抑制依据
- CLI 契约（--help 级）：`chat message reply`（--group/--ref-msg-id/--ref-sender/--uuid）、`chat message list`（稳定字段 messageId/text）、`chat message download-media`（mediaId 域）、`chat +chat-list`
- 个人事件业务负载字段名尚未用真实消息实测；`src/stream.ts` 按候选字段名防御式提取（`msgId/messageId`、`conversationId/openConversationId`、`senderStaffId/senderId`、`text.content`、`atUsers`、`createAt/createTime`、媒体 `mediaId/downloadCode`），首条真实事件到达后如不匹配需回填字段映射

## 待真机验证（统一验证轮）

0. M1–M3：侧栏「钉钉登录」页渲染、/dws/api/state 路由、设备流登录闭环（真机扫码）、静默安装（卸载 dws 后观察自动装回）
1. 真实消息触发：群内 @ 你 / 给你发单聊，确认 Trigger、面板准入与回复链路（含引用回退路径）
2. 事件负载字段映射核对（尤其 mediaId 是否随事件下发、openDingTalkId 是否存在）
3. 单聊回复的收件人参数域（`--user` vs `--open-dingtalk-id`）
4. 多账号并发订阅数是否有服务端上限（N 账号 × 3 订阅）
