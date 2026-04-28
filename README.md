# CoyoteCoder

CoyoteCoder 是一个本地运行的事件驱动兼容层，用来连接 OpenAI 兼容的 Agent 客户端和 DG-LAB Coyote 反馈流程。

它当前的实现以安全和可验证为优先：

- 提供 OpenAI 兼容的 `/v1/*` 代理接口，可供 Codex、Claude Code、OpenCode 等客户端接入。
- 为常见 chat 和 responses 接口生成统一的请求、响应生命周期事件。
- 通过安全层把事件转换为反馈计划，默认只记录 dry-run 结果，不发送真实输出。
- 支持 DG-LAB Socket V2 配对、状态查看、紧急停止和运行时参数调整。
- 提供本地 Web 控制台，并可通过 Tauri v2 运行桌面应用。

DG-LAB 官方开源仓库会放在本地 `DG-LAB-OPENSOURCE/` 目录中作为参考和运行 Socket V2 后端使用，该目录已被本仓库忽略。

## 环境要求

- Windows PowerShell
- Node.js 和 npm
- DG-LAB Socket V2 后端源码位于 `DG-LAB-OPENSOURCE/socket/v2/backend`
- 如需构建桌面端，还需要安装 Rust 工具链和 Tauri v2 所需环境

## 安装依赖

首次使用先安装桥接服务依赖：

```powershell
cd .\coyote-codex-bridge
npm install
```

DG-LAB Socket V2 后端也需要安装依赖，请进入对应目录按其项目要求完成安装。

## 配置

复制示例配置为本地配置文件：

```powershell
Copy-Item .\coyote-codex-bridge\config.example.yaml .\coyote-codex-bridge\config.local.yaml
```

常用配置项：

- `server.host` 和 `server.port`：CoyoteCoder API 与 Web UI 的监听地址，默认 `127.0.0.1:8787`。
- `upstream.active_provider`：当前使用的上游模型服务。
- `upstream.providers`：OpenAI 兼容、本地兼容或其他协议供应商配置。
- `privacy.store_raw_content`：是否保存原始请求内容，默认关闭。
- `safety.dry_run`：是否只生成计划而不发送真实 DG-LAB 输出，默认开启。
- `safety.armed`：真实输出的总开关，默认关闭。
- `dglab.socket_url`：DG-LAB Socket V2 后端地址，默认 `ws://127.0.0.1:9999`。
- `dglab.qr_host`：配对二维码使用的主机地址，默认 `auto` 自动选择局域网 IPv4。

建议在配对和调试期间保持：

```yaml
safety:
  dry_run: true
  armed: false
```

## 快速启动

在仓库根目录运行一键启动脚本：

```powershell
.\scripts\start-all.ps1
```

也可以双击或运行批处理入口：

```powershell
.\start-dev.bat
```

脚本会尝试启动：

- DG-LAB Socket V2 后端，默认端口 `9999`
- CoyoteCoder UI/API 服务，默认端口 `8787`

启动完成后打开控制台：

```text
http://127.0.0.1:8787/ui
```

日志会写入 `.test-logs/`，运行时 PID 和清理脚本会写入 `.runtime/`。保持启动窗口打开，关闭窗口会停止脚本托管的服务。

常用启动参数：

```powershell
.\scripts\start-all.ps1 -NoBrowser
.\scripts\start-all.ps1 -CoyotePort 8788 -DglabPort 9999
.\scripts\start-all.ps1 -Build
```

## 手动启动

只启动 CoyoteCoder 服务：

```powershell
cd .\coyote-codex-bridge
npm run dev
```

构建后运行：

```powershell
cd .\coyote-codex-bridge
npm run build
npm start
```

默认服务地址：

```text
http://127.0.0.1:8787
```

## Web 控制台

打开：

```text
http://127.0.0.1:8787/ui
```

控制台可用于：

- 启动或停止反馈流程
- 切换 dry-run
- 查看 DG-LAB 连接状态
- 生成 DG-LAB 配对二维码
- 调整通道强度、持续时间、频率限制等运行时参数
- 查看最近事件和反馈计划
- 执行紧急停止

## 客户端接入

将 OpenAI 兼容客户端的 Base URL 指向：

```text
http://127.0.0.1:8787/v1
```

示例环境变量：

```powershell
$env:OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
$env:OPENAI_API_KEY="local-placeholder"
```

真实上游 API Key 推荐写入 `config.local.yaml` 或本地环境变量，不要提交到 Git。

更多客户端配置可参考：

```text
coyote-codex-bridge/docs/client-setup.md
```

## DG-LAB 配对

1. 启动 DG-LAB Socket V2 后端和 CoyoteCoder。
2. 保持 `safety.dry_run: true`。
3. 打开 `http://127.0.0.1:8787/ui`。
4. 点击生成配对码，或访问 `GET /dglab/qr`。
5. 使用 APP 扫描二维码。
6. 通过 UI 或 `GET /dglab/status` 确认已绑定。
7. 先发送 dry-run 请求，确认事件和计划正常出现，再考虑真实输出测试。

真实输出测试前请先阅读：

```text
docs/safety.md
```

## 桌面应用

桌面端基于 Tauri v2，源码位于：

```text
coyote-codex-bridge/src-tauri
```

开发模式：

```powershell
.\scripts\start-all.ps1 -NoBrowser
cd .\coyote-codex-bridge
npm run tauri:dev
```

构建桌面应用：

```powershell
cd .\coyote-codex-bridge
npm run tauri:build
```

## 常用接口

- `GET /health`
- `GET /status`
- `GET /ui`
- `GET /events/recent`
- `GET /shock/recent`
- `GET /dglab/status`
- `POST /dglab/connect`
- `POST /dglab/disconnect`
- `GET /dglab/qr`
- `POST /control/arm`
- `POST /control/disarm`
- `POST /control/panic`
- `POST /control/dry-run`

## 验证命令

```powershell
cd .\coyote-codex-bridge
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` 需要本地服务已启动。

## 安全提示

CoyoteCoder 默认是 dry-run 模式。配对、代理请求、事件记录和反馈计划都验证稳定之前，不要关闭 dry-run，也不要开启真实输出。

紧急停止接口：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/control/panic
```

紧急停止会关闭 armed 状态，并为两个通道生成归零计划。再次测试前，请确认 UI 状态和 `docs/safety.md` 中的检查项。
