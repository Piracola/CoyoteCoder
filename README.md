# CoyoteCoder

CoyoteCoder is a local event-driven compatibility layer between OpenAI-compatible agent clients and a DG-LAB Coyote feedback pipeline.

The first implementation is intentionally conservative:

- It exposes OpenAI-compatible `/v1/*` proxy routes for Codex, Claude Code, OpenCode, and similar clients.
- It emits normalized lifecycle events for known chat and responses endpoints.
- It maps those events to dry-run shock plans through a safety layer.
- It keeps real DG-LAB device output disabled until later phases.

DG-LAB's official open-source repository is kept locally as `DG-LAB-OPENSOURCE/` for reference and future updates, but is ignored by this repository.

## Quick Start

Start both the DG-LAB Socket V2 backend and the CoyoteCoder UI/API server:

```powershell
.\scripts\start-all.ps1
```

This opens the console at `http://127.0.0.1:8787/ui` and writes logs to `.test-logs/`.

```powershell
cd .\coyote-codex-bridge
npm install
npm run dev
```

The default server listens on `http://127.0.0.1:8787`.

Open the lightweight local console at:

```text
http://127.0.0.1:8787/ui
```

The console provides feedback start/stop controls, DG-LAB pairing QR display, dry-run switching, and runtime shock parameter tuning.

Useful endpoints:

- `GET /health`
- `GET /status`
- `GET /ui`
- `GET /events/recent`
- `GET /dglab/status`
- `POST /dglab/connect`
- `POST /dglab/disconnect`
- `GET /dglab/qr`
- `POST /control/arm`
- `POST /control/disarm`
- `POST /control/panic`
- `POST /control/dry-run`

Point an OpenAI-compatible client at:

```text
http://127.0.0.1:8787/v1
```

Configure the upstream provider through `config.yaml` or environment variables. See `coyote-codex-bridge/config.example.yaml`.

DG-LAB Socket V2 support is present but disabled by default. Keep `safety.dry_run: true` while pairing and testing.

## Checks

```powershell
cd .\coyote-codex-bridge
npm run typecheck
npm test
npm run build
npm run smoke
```
