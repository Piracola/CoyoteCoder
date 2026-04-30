# CoyoteCoder 开发说明

## 环境依赖

- Node.js 和 npm
- Rust stable 工具链
- Visual Studio Build Tools，需安装 C++ 桌面构建工具
- 如需由脚本托管 DG-LAB Socket V2 后端，需要本地存在 `DG-LAB-OPENSOURCE/socket/v2/backend`

## 本地启动

安装依赖并启动开发环境：

```powershell
cd .\app
npm install
cd ..
.\scripts\start-all.ps1
```

`scripts/start-all.ps1` 会自动创建缺失的本地配置文件，不需要手动复制 `config.example.yaml`。

常用启动参数：

```powershell
.\scripts\start-all.ps1 -NoBrowser
.\scripts\start-all.ps1 -CoyotePort 8788 -DglabPort 9999
.\scripts\start-all.ps1 -Build
```

只启动 API / Web 控制台时：

```powershell
cd .\app
npm run dev
```

默认服务地址为 `http://127.0.0.1:8787`，下游客户端 Base URL 使用 `http://127.0.0.1:8787/v1`。

## 配置与环境变量

默认配置文件为运行目录下的 `config.yaml`，也可以用 `COYOTE_CONFIG` 指定其他路径。`scripts/start-all.ps1` 默认使用 `app/config.local.yaml`。

可用环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `HOST` | 覆盖本地监听地址，仅允许 loopback 地址。 |
| `PORT` | 覆盖 CoyoteCoder HTTP 端口。 |
| `DGLAB_ENABLED` | 启用或关闭 DG-LAB Socket V2 控制器。 |
| `DGLAB_SOCKET_URL` | 覆盖 DG-LAB Socket V2 server 地址。 |
| `DGLAB_QR_HOST` | 覆盖二维码中的主机名；默认 `auto`。 |
| `DGLAB_QR_PORT` | 覆盖二维码中的 Socket V2 端口。 |
| `COYOTE_WAVEFORMS_DIR` | 覆盖自定义 DG-LAB 波形目录。 |

## 构建流程

当前 Windows 便携版构建大致分为：

1. `npm run typecheck` 检查 TypeScript 类型。
2. `npm test` 跑测试。
3. `npm run build` 构建 Web 控制台和后端 JS。
4. 使用 `@yao-pkg/pkg` 将后端打成 `dist/coyote-backend.exe`。
5. `npm run tauri:build` 构建桌面端 `coyote-coder.exe`。
6. 复制 exe、配置、README、图标、UI dist 和 `waveforms/` 示例，压缩成便携版 zip。

## 一键构建

推荐直接在根目录运行：

```powershell
.\scripts\build-portable.ps1
```

也可以运行：

```bat
build-portable.bat
```

指定版本号：

```powershell
.\scripts\build-portable.ps1 -Version 0.1.0
```

跳过安装依赖或测试：

```powershell
.\scripts\build-portable.ps1 -SkipInstall
.\scripts\build-portable.ps1 -SkipTests
```

构建完成后会生成：

```text
dist/CoyoteCoder-版本号-windows-portable.zip
```

## 手动构建

只构建 API 和 Web 控制台：

```powershell
cd .\app
npm run build
```

构建桌面应用：

```powershell
cd .\app
npm run tauri:build
```

## GitHub Actions 构建

推荐使用 GitHub Actions 发布便携版：

1. 推送 `v*` tag，或手动运行 `Build Windows Portable` workflow。
2. workflow 会执行类型检查、测试、API/UI 构建、后端 sidecar exe 构建和 Tauri 桌面构建。
3. 最终上传根目录 `dist/` 下的 `CoyoteCoder-windows-portable.zip` artifact。

## 常用接口

- `GET /health`
- `GET /status`
- `GET /ui`
- `GET /ui/state`
- `POST /ui/settings`
- `POST /ui/upstream`
- `GET /ui/waveforms`
- `POST /ui/waveforms/refresh`
- `POST /ui/test-shock`
- `GET /ui/qr.svg`
- `GET /models`
- `GET /models/:model`
- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/completions`
- `POST /v1/embeddings`（Gemini 上游适配）
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
cd .\app
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` 需要本地服务已启动。
