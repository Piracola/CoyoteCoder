# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CoyoteCoder is a Windows-first local proxy that sits between AI agent clients (Codex, Claude Code, etc.) and upstream model providers. Clients point their OpenAI-compatible Base URL at `http://127.0.0.1:8787/v1`; CoyoteCoder forwards traffic and converts request/response lifecycle events (request start, streaming, tool calls, completion, errors) into DG-LAB 郊狼 feedback device output.

The user is an amateur developer doing vibe coding — keep explanations short and practical, avoid deep protocol detail unless asked. User-facing docs are in Chinese.

## Common Commands

```powershell
# Full local dev stack (auto-creates missing local config), from repo root
.\scripts\start-all.ps1
.\scripts\start-all.ps1 -NoBrowser -Build -CoyotePort 8788 -DglabPort 9999

# From app/ directory
cd .\app
npm run dev          # API + Web console only (tsx watch)
npm run typecheck    # tsc for both API (tsconfig.json) and UI (tsconfig.ui.json)
npm test             # Vitest unit tests
npx vitest run src/shock/safety.test.ts   # single test file
npm run build        # Build UI (vite) then API (tsc)
npm run smoke        # Smoke test — requires a running server
npm run tauri:dev    # Desktop shell dev
npm run tauri:build  # Desktop shell build

# Windows portable release (repo root); -SkipInstall / -SkipTests available
.\scripts\build-portable.ps1 -Version 0.1.0
```

Requires Node.js 24+; Tauri builds also need Rust stable and VS C++ Build Tools. Release builds normally go through the `Build Windows Portable` GitHub Actions workflow (push a `v*` tag).

## Architecture

Runtime flow: Agent client → `/v1/*` proxy → upstream provider → event bus → ShockPolicy → shock engine → SafetyGate → DryRunSink or DglabSink → DG-LAB Socket V2.

All backend code lives in `app/src/`; `app/src/app/runtime.ts` is the composition root that wires config, event bus, policy, engine, SafetyGate, DG-LAB controller/relay, waveforms, and the Fastify server.

- `proxy/server.ts` — Fastify server: `/v1/*` proxy routes, SSE relay, `/control/*`, `/events`, `/shock`, `/dglab` endpoints. `isEventEndpoint()` decides which downstream paths produce feedback — it deliberately includes native `/v1/messages` (Claude Code) and Gemini `:generateContent`, not just the OpenAI trio
- `proxy/upstream.ts` — OpenAI pass-through plus Anthropic (`/v1/messages`) and Gemini (`generateContent`, embeddings) format translation; downstream clients always speak OpenAI format. Streaming translation goes through `buildTranslatedStream` + `StreamTranslation`, which carry tool calls, finish reasons and usage
- `events/bus.ts` — request/response lifecycle events; stores stats only, never raw prompt/response content unless `privacy.store_raw_content` is explicitly enabled
- `shock/policy.ts` → `shock/engine.ts` → `shock/safety.ts` — events become channel plans, coalesced, then gated; sinks are `shock/dryRunSink.ts` and `dglab/sink.ts`. The engine serializes sends (a DG-LAB output is a clear/setStrength/pulse triplet that must not interleave) and stop events invalidate queued work
- `dglab/controller.ts` — WebSocket client for a DG-LAB Socket V2 server with auto-reconnect; `dglab/relay.ts` is a built-in local Socket V2 relay server started by the runtime (external DG-LAB backend not required)
- `dglab/waves.ts` — built-in and file-loaded DG-LAB V3 waveform catalog; user waveforms live in repo-root `waveforms/` (gitignored except README/example)
- `api/ui/*.ts` — Web console API routes (state, settings, upstream providers, runtime start/stop, waveforms, QR, static serving)
- `config/schema.ts` — Zod schema for YAML config

UI: React/Vite app in `app/src-ui/` (served at `/ui`, dev server on port 1420 proxying to the API); Tauri 2 desktop shell in `app/src-tauri/`; `app/src/ui/` is a legacy static fallback console.

Do not edit generated/runtime directories: `.runtime/`, `.test-logs/`, `dist/`, `app/dist/`, `app/src-ui/dist/`, `app/src-tauri/target/`, `node_modules/`. `DG-LAB-OPENSOURCE/` is intentionally gitignored — local protocol reference only.

## Safety Rules

Real DG-LAB output happens only when ALL are true: `dglab.enabled: true`, Socket V2 connected and bound, `safety.dry_run: false`, `safety.armed: true`, and the plan passes SafetyGate limits (panic latch, session/idle ceilings, per-channel spacing, rate limit, intensity ceiling intersected with the device soft limit, ramp cap, duration cap).

- Never bypass SafetyGate when sending DG-LAB output.
- Defaults must stay `dry_run: true` and `armed: false`.
- `POST /control/panic` must remain available and must disarm output.
- Do not store raw prompt or response content unless an explicit debug setting is added and enabled.

The de-escalation path is the exception to gating and must stay that way:

- `shock.zero` / `shock.clear` bypass SafetyGate, and `DglabSink` sends them even when disarmed — disarming does not un-latch strength the device already holds.
- Anything that stops output (panic, exit, link loss, auto-disarm) must actually reach the hardware, not just flip a flag. Zeroing is followed by `controller.flush()` because `ws.send()` only queues.
- An armed session must not outlive the DG-LAB link: `dglab.disconnected` triggers `safety.notifyLinkLost()`.

When touching shutdown, panic, or the sink, keep `src/app/runtime.test.ts` and `src/dglab/sink.test.ts` passing — they are the regression tests for behaviour that `docs/safety.md` promises.

## Config

Default config is `config.yaml` in the running process's working directory (`app/config.yaml` in dev); `scripts/start-all.ps1` uses `app/config.local.yaml`. Override the path with `COYOTE_CONFIG`.

Environment overrides: `HOST` (loopback only), `PORT`, `DGLAB_ENABLED`, `DGLAB_SOCKET_URL`, `DGLAB_QR_HOST`, `DGLAB_QR_PORT`, `COYOTE_WAVEFORMS_DIR`.

`app/config.example.yaml` is validated by `src/config/schema.test.ts` — add new schema fields there too or that test fails.

Note the deliberate asymmetry in bind hosts: `server.host` is restricted to loopback, but the DG-LAB relay binds wider (`dglab.relay_bind_host`, default `0.0.0.0`) because phone pairing needs LAN reachability. The official app cannot present a shared secret, so the relay compensates by rejecting non-private origins rather than by adding a token that would break pairing.
