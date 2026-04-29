# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CoyoteCoder is a local OpenAI-compatible proxy that sits between AI agent clients and upstream model providers, forwarding traffic and emitting events to a DG-LAB feedback device path. The user is an amateur developer using vibe coding.

## Common Commands

```powershell
# From repository root - start full dev stack
.\scripts\start-all.ps1

# From app directory
cd .\app
npm run typecheck    # TypeScript validation
npm test             # Vitest unit tests
npm run build        # Build API and UI
npm run smoke        # Smoke test (requires running server)

# Build Windows portable release
.\scripts\build-portable.ps1 -Version 0.1.0
```

## Architecture

Runtime flow: Agent client → CoyoteCoder `/v1` → Upstream provider → Event bus → ShockPolicy → SafetyGate → DryRunSink or DglabSink

Main source location: `app/src/`

Key components:
- `proxy/server.ts` — Fastify server, handles `/v1/*` proxy routes and SSE relay
- `proxy/upstream.ts` — OpenAI pass-through plus Anthropic/Gemini format translation
- `events/bus.ts` — Stores request/response lifecycle events without raw prompt logging
- `shock/policy.ts` — Converts normalized events into DG-LAB channel plans
- `shock/safety.ts` — Enforces dry-run, arm state, channel limits, rate limits, panic
- `dglab/controller.ts` — WebSocket client for DG-LAB Socket V2 server
- `config/schema.ts` — Zod schema for YAML config validation

Generated/runtime directories to avoid editing: `.runtime/`, `.test-logs/`, `dist/`, `app/dist/`, `node_modules/`, `app/src-ui/dist/`, `app/src-tauri/target/`

External reference: `DG-LAB-OPENSOURCE/` is intentionally gitignored and used only as a local protocol reference.

## Safety Rules

Real DG-LAB output is only possible when ALL of these are true:
1. `dglab.enabled: true`
2. Socket V2 controller connected and bound
3. `safety.dry_run: false`
4. `safety.armed: true`
5. Plan passes SafetyGate limits

Never bypass SafetyGate when sending DG-LAB output. `POST /control/panic` must remain available and must disarm output. Default to `dry_run: true` and `armed: false`.

Do not store raw prompt or response content unless an explicit debug setting is added and enabled.

## Config

Default config path: `app/config.yaml` relative to running process. Override with `COYOTE_CONFIG` environment variable.

Environment overrides: `HOST`, `PORT`, `DGLAB_ENABLED`, `DGLAB_SOCKET_URL`, `DGLAB_QR_HOST`, `DGLAB_QR_PORT`

## Testing

Tests use Vitest. Run single test file:
```powershell
npx vitest run src/shock/safety.test.ts
```

Test coverage focuses on SSE parser, SafetyGate, DG-LAB protocol helper, controller mock WebSocket, and proxy integration.

## Upstream Protocols

| Protocol | Endpoint behavior |
|----------|-------------------|
| OpenAI-compatible | Direct pass-through |
| Anthropic | `/v1/chat/completions` → `/v1/messages`, response translation to OpenAI format |
| Gemini | `/v1/chat/completions` → `/v1beta/models/:model:generateContent`, `/v1/embeddings` translation |

Downstream client always uses OpenAI-compatible base URL: `http://127.0.0.1:8787/v1`
