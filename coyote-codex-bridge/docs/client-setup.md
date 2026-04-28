# Client Setup

CoyoteCoder exposes an OpenAI-compatible base URL:

```text
http://127.0.0.1:8787/v1
```

Any agent client that can set a custom OpenAI-compatible API base URL should be able to route through it.

## Environment

Start the proxy:

```powershell
cd "I:\JBCode\AI Tools\CoyoteCoder\coyote-codex-bridge"
npm run dev
```

Configure upstream access with either `config.yaml` or environment variables:

```powershell
$env:UPSTREAM_PROTOCOL = "openai"
$env:UPSTREAM_BASE_URL = "https://api.openai.com"
$env:OPENAI_API_KEY = "..."
```

You can also change the provider from the local console at:

```text
http://127.0.0.1:8787/ui
```

The API provider panel supports:

| Protocol | Default base URL | API key env |
| --- | --- | --- |
| OpenAI-compatible | `https://api.openai.com` | `OPENAI_API_KEY` |
| Anthropic Messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| Gemini GenerateContent | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |

The downstream client still points to CoyoteCoder's OpenAI-compatible `/v1` base URL. CoyoteCoder converts `/v1/chat/completions` and `/v1/responses` to Anthropic or Gemini format when those protocols are selected.

## Expected Behavior

- `/v1/*` requests are proxied to the configured upstream.
- `/v1/chat/completions` and `/v1/responses` emit Coyote events.
- OpenAI-compatible upstreams are relayed without changing the stream format.
- Anthropic and Gemini upstreams are translated back into OpenAI-compatible JSON or SSE responses for the downstream client.
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
| Codex | Pending real-client verification | Set OpenAI-compatible base URL to `http://127.0.0.1:8787/v1`. |
| Claude Code | Pending real-client verification | Use OpenAI-compatible provider settings if available. |
| OpenCode | Pending real-client verification | Use OpenAI-compatible provider settings if available. |
| LiteLLM downstream clients | Expected compatible | Point client to CoyoteCoder, then point CoyoteCoder upstream to LiteLLM if needed. |
