# CoyoteCoder 开发说明

## 环境依赖

- Node.js 和 npm
- Rust stable 工具链
- Visual Studio Build Tools，需安装 C++ 桌面构建工具
- 如需由脚本托管 DG-LAB Socket V2 后端，需要本地存在 `DG-LAB-OPENSOURCE/socket/v2/backend`

## 本地启动

安装依赖并启动开发环境：

```powershell
cd .\coyote-codex-bridge
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

## 构建流程

当前 Windows 便携版构建大致分为：

1. `npm run typecheck` 检查 TypeScript 类型。
2. `npm test` 跑测试。
3. `npm run build` 构建 Web 控制台和后端 JS。
4. 使用 `@yao-pkg/pkg` 将后端打成 `coyote-backend.exe`。
5. `npm run tauri:build` 构建桌面端 `coyote-coder.exe`。
6. 复制 exe、配置、README、图标和 UI dist，压缩成便携版 zip。

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
coyote-codex-bridge/CoyoteCoder-版本号-windows-portable.zip
```

## 手动构建

只构建 API 和 Web 控制台：

```powershell
cd .\coyote-codex-bridge
npm run build
```

构建桌面应用：

```powershell
cd .\coyote-codex-bridge
npm run tauri:build
```

## GitHub Actions 构建

推荐使用 GitHub Actions 发布便携版：

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
