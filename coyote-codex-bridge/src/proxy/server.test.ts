import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import { ShockPlanStore } from "../shock/planStore.js";
import { ShockPolicy } from "../shock/policy.js";
import { SafetyGate } from "../shock/safety.js";
import { buildServer } from "./server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

async function createMockUpstream(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing mock upstream port");
  return `http://127.0.0.1:${address.port}`;
}

async function createProxy(baseUrl: string, upstreamOverrides: Record<string, unknown> = {}) {
  const config = configSchema.parse({ upstream: { base_url: baseUrl, ...upstreamOverrides } });
  const bus = new EventBus(config.privacy.recent_event_limit);
  const shockPlans = new ShockPlanStore(config.privacy.recent_event_limit);
  const app = buildServer({
    config,
    bus,
    safety: new SafetyGate(config.safety),
    policy: new ShockPolicy(config.policy),
    shockPlans
  });
  servers.push(app.server);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("missing proxy port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, bus, shockPlans };
}

describe("proxy server", () => {
  it("passes through unknown /v1 endpoints without emitting known events", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "br" });
      res.end(brotliCompressSync(JSON.stringify({ object: "list" })));
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/models`);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ object: "list" });
    expect(proxy.bus.getRecent()).toEqual([]);
  });

  it("rejects browser requests from non-local origins", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list" }));
    });
    const proxy = await createProxy(upstream);

    const blocked = await fetch(`${proxy.baseUrl}/health`, {
      headers: { origin: "https://example.com" }
    });
    const allowed = await fetch(`${proxy.baseUrl}/health`, {
      headers: { origin: "http://127.0.0.1:1420" }
    });

    expect(blocked.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:1420");
  });

  it("passes through file and upload routes as upstream traffic", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);

    const files = await fetch(`${proxy.baseUrl}/v1/files`);
    const upload = await fetch(`${proxy.baseUrl}/upload/v1beta/files`, { method: "POST", body: "local file bytes" });

    expect(files.status).toBe(200);
    expect(upload.status).toBe(200);
  });

  it("redacts API keys from recorded upstream error messages", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad Bearer secret-token and api_key=secret-key" } }));
    });
    const proxy = await createProxy(upstream);

    await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "private-model", messages: [{ role: "user", content: "do not store this" }] })
    });

    const event = proxy.bus.getRecent().find((item) => item.type === "response.error_status");
    expect(event).toMatchObject({
      type: "response.error_status",
      message: "bad Bearer [redacted] and api_key=[redacted]"
    });
  });

  it("uses configured OpenAI API keys instead of downstream placeholder keys", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.headers.authorization).toBe("Bearer configured-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    const proxy = await createProxy(upstream, { api_key: "configured-key" });

    const response = await fetch(`${proxy.baseUrl}/v1/models`, {
      headers: { authorization: "Bearer cherry-placeholder" }
    });

    expect(await response.json()).toEqual({ object: "list", data: [] });
  });

  it("adapts Anthropic model lists to OpenAI-compatible model lists", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      expect(req.headers["x-api-key"]).toBe("anthropic-test");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "claude-3-5-sonnet-latest",
              type: "model",
              display_name: "Claude 3.5 Sonnet",
              created_at: "2024-10-22T00:00:00Z"
            }
          ],
          has_more: false
        })
      );
    });
    const proxy = await createProxy(upstream, {
      protocol: "anthropic",
      api_key: "anthropic-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/models`);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "claude-3-5-sonnet-latest",
          object: "model",
          created: 1729555200,
          owned_by: "anthropic"
        }
      ]
    });
    expect(proxy.bus.getRecent()).toEqual([]);
  });

  it("adapts Gemini model lists to OpenAI-compatible model lists", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/models");
      expect(req.headers["x-goog-api-key"]).toBe("gemini-test");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.0-flash",
              displayName: "Gemini 2.0 Flash",
              supportedGenerationMethods: ["generateContent", "countTokens"]
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"]
            }
          ]
        })
      );
    });
    const proxy = await createProxy(upstream, {
      protocol: "gemini",
      api_key: "gemini-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/models`);
    expect(await response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "gemini-2.0-flash",
          object: "model",
          created: 0,
          owned_by: "google"
        }
      ]
    });
    expect(proxy.bus.getRecent()).toEqual([]);
  });

  it("emits events for non-streaming chat completions", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { completion_tokens: 2, total_tokens: 8 } }));
    });
    const proxy = await createProxy(upstream);

    await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [] })
    });

    expect(proxy.bus.getRecent().map((event) => event.type)).toEqual([
      "request.started",
      "request.body_seen",
      "response.started",
      "response.done"
    ]);
    expect(proxy.bus.getRecent().at(-1)).toMatchObject({
      type: "response.done",
      outputTokens: 2,
      totalTokens: 8,
      estimatedTokens: false
    });
  });

  it("emits tool call events from non-streaming responses", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "run_tests", arguments: "{}" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: { completion_tokens: 12, total_tokens: 30 }
        })
      );
    });
    const proxy = await createProxy(upstream);

    await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", messages: [] })
    });

    expect(proxy.bus.getRecent().map((event) => event.type)).toEqual([
      "request.started",
      "request.body_seen",
      "response.started",
      "response.tool_call",
      "response.done"
    ]);
    expect(proxy.bus.getRecent()[3]).toMatchObject({
      type: "response.tool_call",
      toolCallCount: 1,
      toolNames: ["run_tests"]
    });
  });

  it("emits error status events for upstream error responses", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", input: "hi" })
    });

    expect(response.status).toBe(429);
    expect(proxy.bus.getRecent().map((event) => event.type)).toEqual([
      "request.started",
      "request.body_seen",
      "response.started",
      "response.error_status"
    ]);
    expect(proxy.bus.getRecent().at(-1)).toMatchObject({
      type: "response.error_status",
      statusCode: 429,
      message: "rate limited"
    });
  });

  it("passes through SSE and emits chunk events", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"edit_file"}}]}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"completion_tokens":4,"total_tokens":14}}\n\n');
      res.end("data: [DONE]\n\n");
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock", stream: true, input: "hi" })
    });

    expect(await response.text()).toContain("[DONE]");
    expect(proxy.bus.getRecent().map((event) => event.type)).toContain("response.chunk");
    expect(proxy.bus.getRecent().map((event) => event.type)).toContain("response.tool_call");
    expect(proxy.bus.getRecent().at(-1)).toMatchObject({
      type: "response.done",
      outputTokens: 4,
      totalTokens: 14
    });
  });

  it("exposes recent shock plans", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);
    proxy.shockPlans.add({
      timestamp: 1_000,
      eventType: "request.started",
      input: { kind: "shock.plan", channel: "A", intensity: 0.08, durationMs: 120, reason: "request.started" },
      output: { kind: "shock.plan", channel: "A", intensity: 0.08, durationMs: 120, reason: "request.started" },
      outcome: "sent",
      safety: new SafetyGate(configSchema.parse({}).safety).getStatus()
    });

    const response = await fetch(`${proxy.baseUrl}/shock/recent?limit=1`);
    const payload = await response.json();
    expect(payload.plans).toMatchObject([{ eventType: "request.started", outcome: "sent" }]);
  });

  it("records UI test shock attempts when DG-LAB is unavailable", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/ui/test-shock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "A", intensity: 0.05, durationMs: 220 })
    });

    const payload = await response.json();
    expect(payload.testShock).toMatchObject({
      outcome: "error",
      message: "DG-LAB 未启用"
    });
    expect(proxy.shockPlans.getRecent()).toMatchObject([
      {
        eventType: "dglab.test",
        outcome: "error",
        error: "dglab_disabled"
      }
    ]);
  });

  it("adapts OpenAI chat completions to Anthropic messages", async () => {
    let seenBody: unknown;
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/messages");
      expect(req.headers["x-api-key"]).toBe("anthropic-test");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: "claude-mock",
            content: [{ type: "text", text: "anthropic ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 7, output_tokens: 2 }
          })
        );
      });
    });
    const proxy = await createProxy(upstream, {
      protocol: "anthropic",
      api_key: "anthropic-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-mock",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" }
        ]
      })
    });

    const payload = await response.json();
    expect(payload.choices[0].message.content).toBe("anthropic ok");
    expect(seenBody).toMatchObject({
      model: "claude-mock",
      system: "be terse",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
  });

  it("adapts Gemini streaming responses to OpenAI chat chunks", async () => {
    let seenBody: unknown;
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/models/gemini-pro:streamGenerateContent?alt=sse");
      expect(req.headers["x-goog-api-key"]).toBe("gemini-test");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"candidates":[{"content":{"parts":[{"text":"gemini "}],"role":"model"}}]}\n\n');
        res.end('data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}]}\n\n');
      });
    });
    const proxy = await createProxy(upstream, {
      protocol: "gemini",
      api_key: "gemini-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-pro",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      })
    });

    const text = await response.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("gemini ");
    expect(text).toContain("ok");
    expect(text).toContain("[DONE]");
    expect(seenBody).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    });
  });

  it("passes through Anthropic native endpoints with Anthropic headers", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/files?limit=1");
      expect(req.headers["x-api-key"]).toBe("anthropic-test");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const proxy = await createProxy(upstream, {
      protocol: "anthropic",
      api_key: "anthropic-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/files?limit=1`, {
      headers: { authorization: "Bearer downstream-key" }
    });

    expect(await response.json()).toEqual({ data: [] });
  });

  it("passes through Gemini native endpoints by stripping OpenAI v1 prefixes", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1beta/files?pageSize=1");
      expect(req.headers["x-goog-api-key"]).toBe("gemini-test");
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: [] }));
    });
    const proxy = await createProxy(`${upstream}/v1beta`, {
      protocol: "gemini",
      api_key: "gemini-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/files?pageSize=1`, {
      headers: { authorization: "Bearer downstream-key" }
    });

    expect(await response.json()).toEqual({ files: [] });
  });

  it("adapts OpenAI completions to Anthropic messages", async () => {
    let seenBody: unknown;
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/messages");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "completion ok" }],
            model: "claude-mock",
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 }
          })
        );
      });
    });
    const proxy = await createProxy(upstream, {
      protocol: "anthropic",
      api_key: "anthropic-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-mock", prompt: "hi", max_tokens: 12 })
    });

    const payload = await response.json();
    expect(payload.choices[0].text).toBe("completion ok");
    expect(seenBody).toMatchObject({
      model: "claude-mock",
      max_tokens: 12,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
  });

  it("adapts OpenAI embeddings to Gemini embedContent", async () => {
    let seenBody: unknown;
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/models/text-embedding-004:embedContent");
      expect(req.headers["x-goog-api-key"]).toBe("gemini-test");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }));
      });
    });
    const proxy = await createProxy(upstream, {
      protocol: "gemini",
      api_key: "gemini-test"
    });

    const response = await fetch(`${proxy.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-004", input: "hello" })
    });

    const payload = await response.json();
    expect(payload.data[0]).toEqual({ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 });
    expect(seenBody).toEqual({ content: { parts: [{ text: "hello" }] } });
  });

  it("updates upstream provider settings from the UI API", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "coyote-config-"));
    const previousConfig = process.env.COYOTE_CONFIG;
    const configPath = join(configDir, "config.yaml");
    process.env.COYOTE_CONFIG = configPath;
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);

    try {
      await fetch(`${proxy.baseUrl}/ui/upstream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upstream: {
            id: "local-claude",
            name: "Local Claude",
            protocol: "anthropic",
            baseUrl: "https://api.anthropic.com",
            apiKey: "secret",
            timeoutMs: 90000
          }
        })
      });

      const response = await fetch(`${proxy.baseUrl}/ui/upstream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          upstream: {
            id: "local-gemini",
            name: "Local Gemini",
            protocol: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "gemini-secret",
            timeoutMs: 60000
          }
        })
      });

      const state = await response.json();
      expect(state.upstream).toMatchObject({
        activeProvider: "local-gemini",
        name: "Local Gemini",
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        hasApiKey: true,
        timeoutMs: 60000
      });
      expect(state.upstream.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "openai", name: "OpenAI" }),
          expect.objectContaining({ id: "local-claude", name: "Local Claude", hasApiKey: true }),
          expect.objectContaining({ id: "local-gemini", name: "Local Gemini", active: true })
        ])
      );

      const saved = YAML.parse(await readFile(configPath, "utf8"));
      expect(saved.upstream.active_provider).toBe("local-gemini");
      expect(saved.upstream.providers).toHaveLength(3);
      expect(saved.upstream.providers[1]).not.toHaveProperty("api_key_env");
    } finally {
      if (previousConfig === undefined) {
        delete process.env.COYOTE_CONFIG;
      } else {
        process.env.COYOTE_CONFIG = previousConfig;
      }
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("persists UI safety and feedback settings, then resets them to defaults", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "coyote-config-"));
    const previousConfig = process.env.COYOTE_CONFIG;
    const configPath = join(configDir, "config.yaml");
    process.env.COYOTE_CONFIG = configPath;
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);

    try {
      const savedResponse = await fetch(`${proxy.baseUrl}/ui/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dryRun: false,
          safety: {
            channelLimits: { A: 24, B: 18 },
            maxContinuousOutputMs: 4200,
            maxEventsPerMinute: 42
          },
          policy: {
            requestStarted: { channel: "B", coefficient: 0.4, durationMs: 210 },
            responseDone: { channel: "B", coefficient: 0.5, durationMs: 360 }
          }
        })
      });

      const savedState = await savedResponse.json();
      expect(savedState.safety).toMatchObject({
        dryRun: false,
        channelLimits: { A: 24, B: 18 },
        maxContinuousOutputMs: 4200,
        maxEventsPerMinute: 42
      });
      expect(savedState.policy.requestStarted).toMatchObject({ channel: "B", coefficient: 0.4, durationMs: 210 });

      const persisted = YAML.parse(await readFile(configPath, "utf8"));
      expect(persisted.safety).toMatchObject({
        dry_run: false,
        channel_limits: { A: 24, B: 18 },
        max_continuous_output_ms: 4200,
        max_events_per_minute: 42
      });
      expect(persisted.policy.request_started).toMatchObject({ channel: "B", coefficient: 0.4, duration_ms: 210 });

      const resetResponse = await fetch(`${proxy.baseUrl}/ui/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reset-defaults" })
      });
      const resetState = await resetResponse.json();
      expect(resetState.safety).toMatchObject({
        dryRun: false,
        channelLimits: { A: 15, B: 10 },
        maxContinuousOutputMs: 3000,
        maxEventsPerMinute: 120
      });
      expect(resetState.policy.requestStarted).toMatchObject({ channel: "A", coefficient: 1, durationMs: 120 });

      const resetPersisted = YAML.parse(await readFile(configPath, "utf8"));
      expect(resetPersisted.safety).toMatchObject({
        dry_run: false,
        channel_limits: { A: 15, B: 10 },
        max_continuous_output_ms: 3000,
        max_events_per_minute: 120
      });
      expect(resetPersisted.policy.request_started).toMatchObject({ channel: "A", coefficient: 1, duration_ms: 120 });
    } finally {
      if (previousConfig === undefined) {
        delete process.env.COYOTE_CONFIG;
      } else {
        process.env.COYOTE_CONFIG = previousConfig;
      }
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
