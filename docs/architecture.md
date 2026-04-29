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

The selected upstream provider can be OpenAI-compatible, Anthropic Messages, or Gemini GenerateContent. Anthropic and Gemini responses are adapted back into OpenAI-compatible JSON or SSE for the downstream client.

## Main Components

| Component | Path | Role |
| --- | --- | --- |
| Fastify server | `app/src/proxy/server.ts` | Serves health/status/UI routes and proxies downstream requests. |
| Upstream adapter | `app/src/proxy/upstream.ts` | Handles OpenAI pass-through plus Anthropic/Gemini translation. |
| Event bus | `app/src/events/` | Stores request/response lifecycle events without raw prompt logging by default. |
| Shock policy | `app/src/shock/policy.ts` | Converts normalized events into channel plans. |
| Safety gate | `app/src/shock/safety.ts` | Enforces dry-run, arm state, channel limits, rate limits, and panic. |
| DG-LAB controller | `app/src/dglab/` | Talks to the official Socket V2 server when enabled. |
| Web console | `app/src-ui/` | Browser UI for provider settings, pairing, dry-run, arm/disarm, panic, and history. |

## Public Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Basic service health. |
| `GET /status` | Current upstream and safety state. |
| `GET /ui` | Local Web console. |
| `GET /events/recent` | Recent normalized lifecycle events. |
| `GET /shock/recent` | Shock plan history and Safety outcomes. |
| `POST /control/arm` | Enable armed state. |
| `POST /control/disarm` | Disable armed state. |
| `POST /control/panic` | Emergency stop and zero-output path. |
| `POST /control/dry-run` | Toggle dry-run state. |
| `GET /dglab/status` | DG-LAB Socket V2 connection and bind state. |
| `POST /dglab/connect` | Connect to Socket V2 server. |
| `POST /dglab/disconnect` | Disconnect from Socket V2 server. |
| `GET /dglab/qr` | Generate pairing QR data. |
| `/v1/*` | OpenAI-compatible downstream proxy surface. |

## Safety Boundary

Real DG-LAB output is only possible when all of these are true:

1. DG-LAB support is enabled.
2. The Socket V2 controller is connected and bound.
3. `safety.dry_run` is false.
4. `safety.armed` is true.
5. The plan passes `SafetyGate` limits.

`POST /control/panic` must stay outside normal tuning flows and remain available as the fastest stop path.
