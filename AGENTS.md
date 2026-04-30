# CoyoteCoder Agent Notes

用户是业余开发者，使用 vibe coding 开发，不需要过多解释技术细节。

## Project Shape

- Root project: Windows-first CoyoteCoder portable desktop app.
- Main code: `app/` TypeScript Fastify proxy plus React/Vite UI and Tauri shell.
- External reference: `DG-LAB-OPENSOURCE/` is intentionally ignored by git and used only as a local protocol reference.
- UI backend routes live under `app/src/api/ui/`; app wiring lives under `app/src/app/`.
- Tracked waveform examples live in `waveforms/README.md` and `waveforms/example.json`; user-imported waveform files in `waveforms/` stay ignored.
- Generated/runtime folders such as `.runtime/`, `.test-logs/`, `dist/`, `app/dist/`, `node_modules/`, `app/src-ui/dist/`, and `app/src-tauri/target/` should stay out of source edits.

## Common Commands

```powershell
cd .\app
npm run typecheck
npm test
npm run build
```

For the full local dev stack from the repository root:

```powershell
.\scripts\start-all.ps1
```

For the portable Windows build:

```powershell
.\scripts\build-portable.ps1
```

## Safety Rules

- CoyoteCoder must default to `safety.dry_run: true` and `safety.armed: false`.
- Never bypass `SafetyGate` when sending DG-LAB output.
- `POST /control/panic` must remain available and must disarm output.
- Do not store raw prompt or response content unless an explicit debug setting is added and enabled.
- Keep user-facing docs short and practical; avoid deep protocol explanations unless the user asks.

## Config Notes

- Default config path is `app/config.yaml` relative to the running process.
- `COYOTE_CONFIG` can point to another config file.
- `COYOTE_WAVEFORMS_DIR` can point to a custom DG-LAB waveform directory.
- Supported environment overrides: `HOST`, `PORT`, `DGLAB_ENABLED`, `DGLAB_SOCKET_URL`, `DGLAB_QR_HOST`, `DGLAB_QR_PORT`, `COYOTE_WAVEFORMS_DIR`.
