# Architecture

CoyoteCoder is a local bridge between an OpenAI-compatible agent client, an upstream model provider, and an optional DG-LAB Socket V2 feedback path.

## Runtime Flow

```text
Agent client
  -> CoyoteCoder /v1
  -> Upstream provider
  -> Coyote event bus
  -> ShockPolicy
  -> SafetyGate
  -> DryRunSink or DglabSink
```

The downstream client always talks to CoyoteCoder through an OpenAI-compatible base URL:

```text
http://127.0.0.1:8787/v1
```

The selected upstream provider can be OpenAI-compatible, Anthropic Messages, or Gemini GenerateContent. Anthropic and Gemini responses are adapted back into OpenAI-compatible JSON or SSE for the downstream client, including tool calls (streaming and non-streaming), finish reasons, and usage.

## Which Endpoints Produce Feedback

Events — and therefore feedback — are derived from these downstream paths:

- `/v1/chat/completions`, `/v1/responses`, `/v1/completions` (OpenAI-compatible ingress)
- `/v1/messages` (native Anthropic ingress; this is what Claude Code uses)
- `…:generateContent` and `…:streamGenerateContent` (native Gemini ingress)

Streaming intensity is paced on the **generated text**, not the SSE JSON envelope. An envelope adds roughly 120 characters around a 3-character token and its size varies per protocol, so pacing on the raw frame would let framing overhead dominate the curve.

## Main Components

| Component | Path | Role |
| --- | --- | --- |
| Fastify server | `app/src/proxy/server.ts` | Serves health/status/UI routes and proxies downstream requests. |
| Upstream adapter | `app/src/proxy/upstream.ts` | Handles OpenAI pass-through plus Anthropic/Gemini translation. |
| Event bus | `app/src/events/` | Stores request/response lifecycle events without raw prompt logging by default. |
| Shock policy | `app/src/shock/policy.ts` | Converts normalized events into channel plans. |
| Safety gate | `app/src/shock/safety.ts` | Enforces dry-run, arm state, channel limits, rate limits, and panic. |
| DG-LAB controller | `app/src/dglab/` | Talks to a Socket V2 server when enabled, with auto-reconnect. |
| Socket V2 relay | `app/src/dglab/relay.ts` | Built-in relay so phone pairing works without the official backend. Binds wider than `server.host` for LAN reachability and refuses non-private origins. |
| Waveform registry | `app/src/dglab/waves.ts` | Loads built-in and file-based DG-LAB V3 waveforms. |
| App runtime | `app/src/app/` | Wires config, event bus, policy, safety, DG-LAB, waveforms, and Fastify. |
| UI API routes | `app/src/api/ui/` | Serves console state, settings, provider, runtime, waveform, and static UI routes. |
| Web console | `app/src-ui/` | Browser UI for provider settings, pairing, dry-run, arm/disarm, panic, and history. |

## Public Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Basic service health. |
| `GET /status` | Current upstream and safety state. |
| `GET /ui` | Local Web console. |
| `GET /ui/state` | Web console state snapshot. |
| `GET /ui/stream` | Live SSE feed of events plus throttled state snapshots for the console. |
| `POST /ui/settings` | Save dry-run, Safety, policy, and waveform settings. |
| `POST /ui/upstream` | Save, select, or delete upstream providers. |
| `GET /ui/waveforms` | List available built-in and file waveforms. |
| `POST /ui/waveforms/refresh` | Reload waveform files. |
| `POST /ui/test-shock` | Send a Safety-gated test plan. |
| `GET /ui/qr.svg` | Render the current DG-LAB pairing QR code. |
| `GET /events/recent` | Recent normalized lifecycle events. |
| `GET /shock/recent` | Shock plan history and Safety outcomes. |
| `POST /control/arm` | Enable armed state. |
| `POST /control/disarm` | Disable armed state. |
| `POST /control/panic` | Emergency stop; disarms, recalls queued pulses, zeroes both channels. |
| `POST /ui/disconnect` | Disarm, zero, and drop the DG-LAB pairing. |
| `POST /control/dry-run` | Toggle dry-run state. |
| `GET /dglab/status` | DG-LAB Socket V2 connection and bind state. |
| `POST /dglab/connect` | Connect to Socket V2 server. |
| `POST /dglab/disconnect` | Disconnect from Socket V2 server. |
| `GET /dglab/qr` | Generate pairing QR data. |
| `/v1/*` | OpenAI-compatible downstream proxy surface. |
| `/models` and `/models/:model` | Compatibility aliases for clients that omit `/v1`. |

## Waveforms

Built-in waveforms are always available. Additional DG-LAB V3 waveforms are loaded from `waveforms/` beside the repo or runtime directory, or from `COYOTE_WAVEFORMS_DIR` when set. The tracked files in `waveforms/` are only the README and example; user-imported waveforms stay local.

## Safety Boundary

Real DG-LAB output is only possible when all of these are true:

1. DG-LAB support is enabled.
2. The Socket V2 controller is connected and bound.
3. `safety.dry_run` is false.
4. `safety.armed` is true.
5. The plan passes `SafetyGate` limits.

`POST /control/panic` must stay outside normal tuning flows and remain available as the fastest stop path.

Custom waveforms do not bypass this boundary: policy selects a `waveform_id`, then `SafetyGate` still clamps or blocks the resulting plan before `DglabSink` can send it.
