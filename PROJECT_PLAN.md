# CoyoteCoder Project Plan

状态日期：2026-04-30

## 1. 项目目标

CoyoteCoder 是一个本地事件驱动兼容层，用 OpenAI-compatible API 连接 agent 客户端与 DG-LAB 郊狼反馈链路。

目标客户端不限定为 Codex。凡是可配置 OpenAI base URL 的 agent 客户端，例如 Claude Code、OpenCode、LiteLLM 下游客户端等，都应尽量兼容。

核心原则：

- 代理层保持 OpenAI-compatible，不写死单一客户端行为。
- Shock Engine 只消费标准事件，不直接依赖 HTTP 代理或 DG-LAB 协议。
- 所有真实设备输出必须经过 Safety 层。
- 默认 dry-run，真实设备输出必须显式关闭 dry-run 并手动 arm。
- 默认不记录 prompt / response 原文，只记录统计信息。
- DG-LAB 官方仓库保留为本地外部参考，路径 `DG-LAB-OPENSOURCE/`，不纳入本项目 git。

## 2. 当前基线

已完成的基础能力不再展开记录，当前可用基线如下：

- `app/` TypeScript 项目已建立。
- `/v1/*` OpenAI-compatible 代理已可透传。
- `/v1/chat/completions`、`/v1/responses` 与 `/v1/completions` 已产生请求、响应和 SSE chunk 事件。
- 上游供应商支持 OpenAI-compatible 透传，以及 Anthropic Messages / Gemini GenerateContent 的基础格式转换。
- `/v1/models` 与 `/v1/models/:model` 会以 OpenAI-compatible 形状返回当前上游模型列表或单模型信息。
- Gemini 上游已支持 `/v1/embeddings` 的 OpenAI-compatible 适配。
- dry-run Shock Engine、安全状态机和控制接口已存在。
- Vitest 测试已覆盖 SSE parser、SafetyGate、DG-LAB protocol helper、DG-LAB controller mock WebSocket、proxy 集成。
- DG-LAB Socket V2 protocol helper、controller、sink 和 `/dglab/*` 状态接口已存在。
- DG-LAB 配对能力默认启用，二维码 host 默认 `auto`，用于开箱生成可扫码的局域网配对链接；真实输出仍默认 dry-run / unarmed。
- Shock Engine 已记录 shock plan 历史，可通过 `/shock/recent` 和控制台历史区观察 Safety 后的发送 / 拦截 / 错误结果。
- Web 控制台已迁移到 React/Vite 结构，并拆分为总览、运行配对、供应商、反馈规则、安全设置和日志视图。
- UI 后端路由已拆分到 `app/src/api/ui/`，运行时组装已集中到 `app/src/app/runtime.ts`。
- 已支持 `waveforms/` 自定义 DG-LAB V3 波形目录，反馈规则可为不同事件选择 `waveform_id`。
- 流式输出默认使用连续波形计划，并在 Shock Engine / DglabSink 两侧做刷新节流。
- 代理层已兼容裸 `/models` 请求、桌面客户端 origin 与自定义预检请求头。
- 已通过 `npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`、`GET /health`、`GET /dglab/status` 验证。
- 已启动官方 Socket V2 backend 做本地联调，`GET /dglab/qr` 可获取 clientId 和二维码链接。
- 已用模拟 APP WebSocket 完成 bind 握手测试，CoyoteCoder 可进入 bound 状态；真实 APP 扫码尚待人工验证。
- git 仓库已初始化，远程为 `https://github.com/Piracola/CoyoteCoder`。

## 3. 下一步方向

### 3.1 验证真实 agent 客户端兼容性

目的：确认本项目不是 Codex-only。

下一步任务：

1. 用至少一个真实客户端指向 `http://127.0.0.1:8787/v1`。
2. 根据真实验证结果更新 `app/docs/client-setup.md`。
3. 验证以下链路：
   - 非流式请求可用
   - 流式请求不破坏 SSE
   - `/events/recent` 能看到事件
   - 控制台可看到 dry-run shock plan
4. 记录不同客户端的差异：
   - header 差异
   - endpoint 差异
   - stream 格式差异
   - 是否使用 `/v1/responses`

验收：

- 至少一个真实 agent 客户端完成 dry-run 链路验证。
- 文档中明确 Claude Code / OpenCode / Codex 的接入方式或待验证状态。

### 3.2 联调 DG-LAB Socket V2 控制器

目的：验证本项目能作为第三方控制端连接官方 Socket V2 server，但继续保持默认安全。

官方参考路径：

```text
DG-LAB-OPENSOURCE/socket/v2/README.md
DG-LAB-OPENSOURCE/socket/v2/backend
DG-LAB-OPENSOURCE/socket/v2/frontend/wsConnection.js
DG-LAB-OPENSOURCE/socket/DG_WAVES_V2_V3_simple.js
```

下一步任务：

1. 启动官方 `DG-LAB-OPENSOURCE/socket/v2/backend`。
2. 设置 `dglab.enabled: true`，保持 `safety.dry_run: true`。
3. 请求 `GET /dglab/qr`，确认能获取 `clientId` 和二维码链接。
4. 用 APP 扫码绑定，确认 `/dglab/status` 进入 bound。
5. 观察 APP 回传的 strength / feedback 事件是否进入 `/events/recent`。
6. 保持 dry-run 做一次完整代理请求，确认不会发送真实设备输出。

验收：

- 能连接官方 Socket V2 server。
- 能获取 clientId 并生成二维码链接。
- APP 扫码绑定后能进入 bound 状态。
- 保持 dry-run 时不会发送真实强度或波形。
- panic 总是可用。

### 3.3 策略调优和可观测性

目的：让反馈节奏更自然，同时不突破安全边界。

下一步任务：

1. 继续用真实请求调 chunk 速度、chunk 长度和响应阶段的默认参数。
2. 观察连续波形在真实 APP 上的体感，必要时调整默认波形和持续时间。
3. 补更多策略测试，覆盖低速、高速、长 chunk、短 chunk。
4. 继续完善 shock plan 历史展示，便于观察调参效果。（已完成基础查询和 UI 展示）

验收：

- 快慢响应有可感知差异。
- 高速流式响应不会超过 Safety 限流。
- 策略参数能通过配置文件调整。

### 3.4 最后扩展命令事件

目的：捕获 agent 本地命令执行时的 stdout / stderr 节奏。

候选路线：

- PowerShell wrapper
- Node child_process wrapper
- MCP/tool wrapper
- 后续如发现稳定 Codex 本地事件源，再单独接入

验收：

- 产生 `command.started`、`command.output`、`command.done`、`command.error`。
- 输出内容默认不落盘。
- 大量输出仍受 Safety 限流保护。

## 4. 当前优先级

短期优先级：

1. 用真实 agent / 桌面客户端做 dry-run 代理验证，并更新 client setup 文档。
2. 用真实 DG-LAB APP 扫码验证 `/dglab/qr`、APP 绑定、`/dglab/status` 和自定义波形。
3. 用 shock plan 历史记录继续调策略参数，补覆盖低速 / 高速 / 长短 chunk 的策略测试。
4. 在真实设备前，按 `docs/safety.md` 操作流程逐步验证。
5. 根据真实客户端和 APP 联调结果修正兼容性差异。

暂缓事项：

- LiteLLM 只作为可配置上游，不主动引入。
- 命令输出监听放到 DG-LAB 基础链路稳定之后。
- 不直接使用蓝牙协议，优先走官方 Socket V2。

## 5. 安全红线

- 不允许绕过 Safety 直接调用 DG-LAB Controller。
- 不允许默认发送真实设备输出。
- 不允许在 panic 后继续输出。
- 不允许记录完整 prompt / response，除非显式 debug 配置开启。
- 不允许把 `DG-LAB-OPENSOURCE/` 纳入本项目提交。
