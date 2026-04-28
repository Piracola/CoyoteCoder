<div align="center">

<img src="./CoyoteCoder.png" alt="CoyoteCoder" width="128" />

# CoyoteCoder

[![Build Windows Portable](https://github.com/Piracola/CoyoteCoder/actions/workflows/portable-windows.yml/badge.svg)](https://github.com/Piracola/CoyoteCoder/actions/workflows/portable-windows.yml)
[![Latest Release](https://img.shields.io/github/v/release/Piracola/CoyoteCoder?label=release)](https://github.com/Piracola/CoyoteCoder/releases)
![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB)

CoyoteCoder 是一个在本机运行的 LLM 代理工具。它位于你的 AI 客户端和上游模型服务之间，负责转发请求、观察模型返回内容，并按你的设置把反馈计划发送给 DG-LAB。

你可以把它理解成一个带控制台的本地中转站：下游客户端仍然使用兼容 OpenAI 的 API 地址，上游模型、API Key、DG-LAB 配对和反馈参数都在 CoyoteCoder 控制台里配置。

- 首次启动默认是预览模式，只记录计划，不会直接向设备输出。
- 需要真实反馈时，请在控制台完成配对、点击“启动反馈”，并关闭预览模式。
- 默认不保存原始请求内容，控制台和事件记录只展示统计信息，减少提示词、响应正文和 API Key 的额外暴露。

</div>



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
CoyoteCoder.png
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



## 开发说明

开发、构建、接口和验证命令请看 [DEVELOPMENT.md](./DEVELOPMENT.md)。



## 致谢

感谢 [Linux Do](https://linux.do/) 热心佬友提供项目灵感❤️。
