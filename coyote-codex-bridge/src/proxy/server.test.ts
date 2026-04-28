import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
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
  const app = buildServer({ config, bus, safety: new SafetyGate(config.safety), policy: new ShockPolicy(config.policy) });
  servers.push(app.server);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("missing proxy port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, bus };
}

describe("proxy server", () => {
  it("passes through unknown /v1 endpoints without emitting known events", async () => {
    const upstream = await createMockUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list" }));
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/models`);
    expect(await response.json()).toEqual({ object: "list" });
    expect(proxy.bus.getRecent()).toEqual([]);
  });

  it("emits events for non-streaming chat completions", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
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
  });

  it("passes through SSE and emits chunk events", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"a"}\n\n');
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

  it("updates upstream provider settings from the UI API", async () => {
    const upstream = await createMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/ui/upstream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        upstream: {
          name: "Local Claude",
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          apiKey: "secret",
          anthropicVersion: "2023-06-01",
          timeoutMs: 90000
        }
      })
    });

    const state = await response.json();
    expect(state.upstream).toMatchObject({
      name: "Local Claude",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      hasApiKey: true,
      anthropicVersion: "2023-06-01",
      timeoutMs: 90000
    });
  });
});
