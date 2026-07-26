# Client Setup

CoyoteCoder exposes an OpenAI-compatible base URL:

```text
http://127.0.0.1:8787/v1
```

Any agent client that can set a custom OpenAI-compatible API base URL should be able to route through it.

## Environment

Start the proxy:

```powershell
cd "I:\JBCode\AI Tools\CoyoteCoder\app"
npm run dev
```

Configure upstream access in `config.yaml` or from the local console. API keys are stored in the selected config file:

```yaml
upstream:
  active_provider: "openai"
  providers:
    - id: "openai"
      name: "OpenAI"
      protocol: "openai"
      base_url: "https://api.openai.com"
      api_key: "..."
      timeout_ms: 120000
```

You can also change the provider from the local console at:

```text
http://127.0.0.1:8787/ui
```

The API provider panel supports multiple saved providers:

| Protocol | Default base URL |
| --- | --- |
| OpenAI-compatible | `https://api.openai.com` |
| Anthropic Messages | `https://api.anthropic.com` |
| Gemini GenerateContent | `https://generativelanguage.googleapis.com/v1beta` |

The downstream client still points to CoyoteCoder's OpenAI-compatible `/v1` base URL. CoyoteCoder converts `/v1/chat/completions` and `/v1/responses` to Anthropic or Gemini format when those protocols are selected.

## Native Anthropic Clients

Clients that speak Anthropic's own API (Claude Code among them) call `POST /v1/messages`. CoyoteCoder passes that through to an Anthropic upstream **and** derives feedback events from it, so those clients get the same feedback as OpenAI-compatible ones. Point them at:

```text
http://127.0.0.1:8787
```

Note this path is a pass-through, not a translation: `/v1/messages` requires an Anthropic upstream. A client speaking Anthropic format against an OpenAI or Gemini upstream is not supported.

Model discovery is exposed through the same downstream base URL:

```text
GET http://127.0.0.1:8787/v1/models
```

CoyoteCoder also accepts clients that request `/models` without the `/v1` prefix and forwards query parameters such as pagination cursors.

CoyoteCoder forwards OpenAI-compatible providers directly. For Anthropic and Gemini providers, it queries the provider's model list endpoint and returns an OpenAI-compatible `object: "list"` response for downstream clients.

If the downstream client sends an API key in `Authorization`, `x-api-key`, `x-goog-api-key`, or `api-key`, CoyoteCoder forwards that key upstream. If the client does not send one, the saved provider key in `config.yaml` is used.

## Expected Behavior

- `/v1/*` requests are proxied to the configured upstream.
- `/v1/models` returns the selected upstream provider's model list in an OpenAI-compatible shape.
- `/v1/models/:model` returns a selected model in an OpenAI-compatible shape when the upstream supports model lookup.
- `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/messages`, and Gemini's `…:generateContent` paths emit Coyote events.
- OpenAI-compatible upstreams are relayed without changing the stream format.
- Anthropic and Gemini upstreams are translated back into OpenAI-compatible JSON or SSE responses for the downstream client, including tool calls, finish reasons, and usage.
- Gemini upstreams support `/v1/embeddings` translation.
- Image, audio, and file content parts are dropped when translating to Anthropic or Gemini; a visible placeholder is substituted so the omission is not silent.
- Shock plans remain dry-run by default.

Useful checks:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:8787/status
Invoke-RestMethod http://127.0.0.1:8787/events/recent
```

## Client Notes

| Client | Status | Notes |
| --- | --- | --- |
| Codex | Pending real-client verification | Set OpenAI-compatible base URL to `http://127.0.0.1:8787/v1`. Uses `/v1/responses`. |
| Claude Code | Pending real-client verification | Native path: set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` with an Anthropic upstream selected. Feedback events now come from `/v1/messages`. |
| OpenCode | Pending real-client verification | Use OpenAI-compatible provider settings if available. |
| Desktop OpenAI-compatible clients | Expected compatible | Supports browser preflight and desktop-style origins such as `app://...`. |
| LiteLLM downstream clients | Expected compatible | Point client to CoyoteCoder, then point CoyoteCoder upstream to LiteLLM if needed. |
