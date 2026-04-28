<div align="center">

# CoyoteCoder

CoyoteCoder 是一个本地运行的 LLM API 兼容层，用于监测上游 LLM 返回的内容并向DG-LAB发送指令。

</div>

原理：客户端请求由 CoyoteCoder 转发至用户配置的上游模型服务，监测并根据返回内容向郊狼发送指令。

首次启动时默认为预览模式，此时不会向郊狼发送指令，需点击“启动反馈”和关闭预览模式。

代理层默认不保存原始请求内容，控制台和事件记录只展示统计信息，避免额外泄露提示词、响应正文或 API Key。

## 使用指南

在 [Release](https://github.com/Piracola/CoyoteCoder/releases)中下载最新发行版

1. 下载并解压 zip 。
2. 运行 `CoyoteCoder.exe`。
3. 首次启动会自动创建 `config.yaml`，此文件用于记录软件配置。
4. 打开控制台后，在“API 供应商”中填写上游模型服务和 API Key。
5. 将下游客户端的 Base URL 设置为：

```text
http://127.0.0.1:8787/v1
```



删除整个解压文件夹即可卸载。



## 便携版目录

zip 解压后主要包含：

```text
CoyoteCoder.exe
coyote-backend.exe
config.example.yaml
src-ui/dist/
README.md
```

运行后会在同一目录下生成：

```text
config.yaml
logs/
```



## 配置文件

`config.yaml` 会在首次启动时自动生成。常用配置项：

- `server.host` 和 `server.port`：本地 API 与控制台后端地址，默认 `127.0.0.1:8787`。
- `upstream.active_provider`：当前使用的上游模型服务。
- `upstream.providers`：OpenAI 兼容、Anthropic、Gemini 或本地兼容供应商配置。
- `privacy.store_raw_content`：是否保存原始请求内容，默认关闭。
- `safety.dry_run`：是否只生成计划而不发送真实 DG-LAB 输出，默认开启。
- `safety.armed`：真实输出总开关，默认关闭。
- `dglab.socket_url`：DG-LAB Socket V2 后端地址，默认 `ws://127.0.0.1:9999`。
- `dglab.qr_host`：配对二维码使用的主机地址，默认 `auto` 自动选择局域网 IPv4。

建议在配对和调试期间保持：

```yaml
safety:
  dry_run: true
  armed: false
```

真实输出测试前请先阅读：

```text
docs/safety.md
```



## Web 控制台

桌面端会自动启动本地后端。也可以在浏览器打开：

```text
http://127.0.0.1:8787/ui
```



## DG-LAB 配对

1. 确认 DG-LAB Socket V2 服务可访问，默认地址为 `ws://127.0.0.1:9999`。
2. 在控制台中生成配对码。
3. 使用郊狼 APP 扫描二维码。

紧急停止接口：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8787/control/panic
```



## 开发者

需要安装依赖：

- Node.js 和 npm
- 如需构建桌面端，需要 Rust 工具链和 Tauri v2 所需环境
- 如需由脚本托管 DG-LAB Socket V2 后端，需要本地存在 `DG-LAB-OPENSOURCE/socket/v2/backend`

安装并启动：

```powershell
cd .\coyote-codex-bridge
npm install
cd ..
.\scripts\start-all.ps1
```

`scripts/start-all.ps1` 会自动创建缺失的本地配置文件，不再需要手动复制 `config.example.yaml`。

常用启动参数：

```powershell
.\scripts\start-all.ps1 -NoBrowser
.\scripts\start-all.ps1 -CoyotePort 8788 -DglabPort 9999
.\scripts\start-all.ps1 -Build
```

## 开发者：桌面构建

本地构建桌面应用：

```powershell
cd .\coyote-codex-bridge
npm run tauri:build
```

推荐使用 GitHub Actions：

1. 推送 `v*` tag，或手动运行 `Build Windows Portable` workflow。
2. workflow 会执行类型检查、测试、API/UI 构建、后端 sidecar exe 构建和 Tauri 桌面构建。
3. 最终上传 `CoyoteCoder-windows-portable.zip` artifact。

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
