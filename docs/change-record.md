# Change Record

## 2026-07-26

一轮以安全边界和感知完整性为主的修复，起因是发现文档承诺的若干安全行为并未真正实现。

### 安全修复（真实缺陷）

- `panic_zero_on_exit` 此前只改内存状态、从不给设备归零。退出路径改为：panic → 排空发送队列 → 撤回排队脉冲 → 归零两个通道 → 等待帧真正离开 socket → 才关闭传输层。`SIGINT`/`SIGTERM`/`SIGBREAK` 和未捕获异常都走这条路。
- 归零指令可能在 socket 关闭前还没发出去（`ws.send` 只是入队）。新增 `flush()` 等待缓冲排空，并在关闭 relay 前留出转发时间。
- DG-LAB 断线后系统仍保持 armed 且设备维持最后强度。现在断线（含 APP 解绑）会自动解除 armed 并归零，同时控制器带指数退避自动重连。
- `ShockEngine` 的发送改为串行，避免两个事件的 `clear/setStrength/pulse` 三连包在线路上交错；停止类事件会作废排队中的计划。发送失败后会尝试把该通道归零。
- relay 的脉冲转发定时器此前无法取消，panic 和退出都拦不住。现在逐客户端追踪并可撤回。
- `DglabSink` 此前在未 armed 时连归零/清除计划也一并拦下。解除 armed 并不会让设备自己卸掉已锁存的强度，因此降级路径不再受 armed 状态限制（dry-run 仍然不发送任何东西，因为本来就没输出过）。
- `POST /control/panic` 改为直接归零，不再依赖事件经过 shock engine 这条链路是否健康。

### 安全模型补强

- 新增强度爬升上限（`max_intensity_step`）、通道最小间隔（`min_interval_ms`）、单次会话时长上限（`max_session_ms`）、闲置自动解除（`idle_disarm_ms`）。
- 尊重郊狼 APP 上报的软上限（`respect_device_soft_limit`），与本地上限取更严格的一方——此前该值被记录但从不使用。
- relay 绑定地址可配置，并默认拒绝来自非私有网段的连接（官方 APP 无法携带自定义密钥，因此不引入会破坏配对协议的令牌机制）。

### 感知与代理层

- `/v1/messages`（Anthropic 原生入口，Claude Code 使用）此前完全不产生事件，等于该客户端下整个产品没有反馈。现已纳入事件端点，Gemini 原生 `:generateContent` 同样纳入。
- 流式强度改用真实生成文本的字符数，而非 SSE 的 JSON 包壳长度——包壳会在 3 字符的 token 外套约 120 字符，且各协议差异很大。
- Anthropic / Gemini 上游的流式 tool call 此前被整体丢弃，agent 工具循环无法成立。现已透传为 OpenAI `tool_calls`，并补上真实 `finish_reason` 与 usage。
- `/v1/responses` 的扁平 tools 与 `function_call_output` 不再被丢弃；合成的流式事件补齐了 item/content_part 生命周期。
- 修复流式响应从不下发 `content-type: text/event-stream`；修复客户端断开后翻译流不取消上游导致的连接与计费泄漏；新增流式空闲超时。
- 畸形请求体返回 400 而非 502。

### 清理与体验

- 移除死配置 `dglab.default_channels`；实现此前无人读取的 `privacy.store_raw_content`（默认关闭的调试开关）；`token_target` 现在可从控制台编辑。
- 强度系数上限从 1 放宽到 2（可放大），分辨率从 0.1 提升到 0.05。
- 波形目录缓存 TTL 从 2 秒提到 5 分钟——它位于输出热路径上；非法样本不再静默丢弃，会在控制台报告。
- 控制台改为 SSE 实时推送（`GET /ui/stream`），替代 3 秒轮询；新增波形形状预览与逐个试放、通道实时强度表、会话倒计时、配对网卡候选提示。
- `/ui/stop` 改为归零但保留配对，暂停后无需重新扫码；`/ui/disconnect` 用于真正断开。
- 桌面壳：托盘不再硬编码 8787 端口，并且重复启动不会再拉起第二个后端。

### 复审后追加修复

提交前对本轮改动做了一次独立复审，发现并修掉了下列问题，其中几条是本轮自己引入的回归：

- **控制器的 socket 回调没有绑定到具体 socket**：`disconnect()` 后再 `connect()`，旧 socket 迟到的 close 事件会清空新连接的 `clientId`/`targetId`，导致此后每次 `zeroAll()` 都静默失败。现在每个回调都校验 socket 身份，断开时先摘监听再关闭。
- **`panic_zero_on_exit: false` 时退出路径不安全**：跳过了 panic 与排空，且 `dispose()` 只清会话不解除 armed，会留下一个永久 armed 且不会过期的 gate；归零之后还可能再发出一次输出。现在无论该开关如何都会先关闸并排空，只有"是否主动归零"受它控制。
- **工具调用参数被算作 0 字符**：`chars` 改用真实文本后，只统计了纯文本，而 agent 的一轮工作往往主要是工具参数和思考内容——恰好打在本轮新增支持的 Claude Code 场景上。现已覆盖 OpenAI `tool_calls.function.arguments`、Anthropic `input_json_delta`/`thinking_delta`、Responses `function_call_arguments.delta`、Gemini `functionCall` 与 `reasoning_content`。
- **`/ui/stream` 丢失 CORS 响应头**：桌面端从 `tauri.localhost` 访问 `127.0.0.1`，属跨域，实时推送会被浏览器拒绝并永久退回轮询；开发环境因为走 Vite 同源代理而看不出来。
- **Responses 端点的 usage 字段名用错**：应为 `input_tokens`/`output_tokens` 而非 Chat 的 `prompt_tokens`/`completion_tokens`（流式与非流式两条路径都错）。
- **Responses 的 `output_index` 不连续**：纯工具调用的一轮里没有 index 0 的消息项，导致事件里的下标与最终 `output` 数组对不上。现在按发出顺序分配。
- **usage chunk 无条件下发**：真实 OpenAI 仅在 `stream_options.include_usage` 时发送，而不少客户端不加保护地读 `choices[0]`。现已按需下发。
- **Anthropic 的 ping 被吞掉**：长思考期间上游只发 ping 时，流在空闲检测器看来完全静止，会被误判为卡死。现在转成 SSE 注释透传。
- **relay 的 `time` 字段无上限**：局域网对端一条消息即可让进程分配任意多定时器并卡死事件循环，连带拖垮所有停止路径。现已封顶，且拿不到 sender 时直接拒绝（无法追踪的定时器 panic 撤不回）。
- **panic 谎报成功**：设备未连接时 `/control/panic` 仍返回 `zeroed: true`。现在如实反映是否真的送达。
- **自动解除未撤回排队脉冲**：与手动停止路径不对称，现已对齐。
- **`/ui/test-shock` 绕过串行链路**：与引擎的三连包可能交错，现已并入同一条链。
- **前端**：表单一变脏就重建 SSE 连接（回调身份随 dirty 标志变化）；兜底轮询未按连接状态门控，会用旧快照覆盖新状态；活动指示器每个 token 触发一次全树重渲染。均已改为 ref + 每秒采样。
- **Anthropic 缺省 `max_tokens` 从 4096 提到 32000 是错的**：超过 claude-3-opus 等模型的上限会直接 400。已改回 4096（仅在客户端完全没传时生效）。

### 工程

- 新增 `verify` workflow，在推送到 `main` 和所有 PR 上跑类型检查/测试/构建（此前只有打 tag 才跑）。
- 修复 CI 打包漏掉 `waveforms/` 示例目录。
- 测试从 58 个增加到 89 个，新增退出归零、断线解除、脉冲撤回、未 armed 时的归零、流式 tool call、`/v1/messages` 事件、chunk 字符统计、示例配置校验等回归测试。

### 验证记录

- 2026-07-26 已执行：`npm run typecheck`、`npm test`（89 通过）、`npm run build`、`cargo check`
- 2026-07-26 已实机验证：服务启动、`/ui/stream` 实时推送与跨域响应头、网卡候选排序、波形预览解码

### 仍待真机验证

- 真实郊狼 APP 扫码配对后的完整输出链路（本轮所有 DG-LAB 测试均通过内置 relay + 模拟 APP 完成）。
- 真实 Claude Code / Codex 客户端接入（`PROJECT_PLAN.md` 3.1 的验收项）。

## 2026-04-30

本次整理把当前工作区里的功能改动归成一个可交接的版本。

### 已完成

- 重构 Web 控制台为 React/Vite 主界面，保留旧 `app/src/ui/` 作为未构建前端时的轻量提示页。
- 拆分 UI 后端路由到 `app/src/api/ui/`，并新增统一运行时上下文 `app/src/app/`。
- 新增 DG-LAB V3 波形目录加载：内置默认波形和流式连续波形，支持 `waveforms/` 中的 JSON / 文本波形文件。
- 反馈规则支持为每类事件选择 `waveform_id`，流式输出改为连续计划并做节流，避免高频 chunk 撞上 Safety 限流。
- 控制台新增波形刷新、波形选择、测试电击、后台运行开关和更完整的状态/日志视图。
- 代理层增强客户端兼容性：支持裸 `/models` 请求、转发浏览器预检请求头、允许桌面客户端 origin，并优先使用下游请求携带的 API key。
- 便携构建会带上 `waveforms/README.md` 和 `waveforms/example.json`，用户导入的其他波形文件继续保持 git 忽略。

### 安全边界

- 默认仍是 `safety.dry_run: true` 与 `safety.armed: false`。
- 所有真实 DG-LAB 输出仍必须经过 `SafetyGate`。
- `POST /control/panic` 继续作为紧急停止入口，并会解除 armed 状态。
- `app/config.yaml` 作为本地运行配置忽略，不进入提交，避免后续误提交 API key。

### 验证记录

- 2026-04-30 已执行：`npm run typecheck`
- 2026-04-30 已执行：`npm test`
- 2026-04-30 已执行：`npm run build`
