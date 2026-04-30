# Change Record

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
