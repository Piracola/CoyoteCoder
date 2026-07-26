import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import type { CoyoteEvent } from "../events/types.js";
import { ShockPlanStore } from "../shock/planStore.js";
import { ShockPolicy } from "../shock/policy.js";
import { SafetyGate } from "../shock/safety.js";
import { buildServer } from "./server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map(closeServer));
  servers.length = 0;
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}

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
  const app = buildServer({
    config,
    bus,
    safety: new SafetyGate(config.safety),
    policy: new ShockPolicy(config.policy),
    shockPlans: new ShockPlanStore(config.privacy.recent_event_limit)
  });
  servers.push(app.server);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("missing proxy port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, bus };
}

function sse(body: string[]): string {
  return body.map((line) => `${line}\n\n`).join("");
}

async function readSseText(response: Response): Promise<string> {
  return response.text();
}

function eventsOfType<T extends CoyoteEvent["type"]>(bus: EventBus, type: T): CoyoteEvent[] {
  return bus.getRecent().filter((event) => event.type === type);
}

describe("native Anthropic ingress", () => {
  it("emits lifecycle events for /v1/messages so Claude Code produces feedback", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_1",
          model: "claude-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello from claude" }],
          usage: { input_tokens: 12, output_tokens: 7 }
        })
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }] })
    });

    expect(response.status).toBe(200);
    expect(eventsOfType(proxy.bus, "request.started")).toHaveLength(1);

    const done = eventsOfType(proxy.bus, "response.done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outputTokens: 7, estimatedTokens: false });
  });

  it("counts tool_use blocks on the native path", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [{ type: "tool_use", id: "toolu_1", name: "edit_file", input: { path: "a.ts" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 3, output_tokens: 4 }
        })
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", messages: [] })
    });

    const toolCalls = eventsOfType(proxy.bus, "response.tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallCount: 1, toolNames: ["edit_file"] });
  });
});

describe("Anthropic streaming translation", () => {
  it("forwards tool calls, finish reason and usage to an OpenAI client", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"run_tests"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"suite\\":"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"unit\\"}"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":23}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "go" }]
      })
    });

    const text = await readSseText(response);

    expect(text).toContain('"name":"run_tests"');
    expect(text).toContain('{\\"suite\\":');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('"completion_tokens":23');
    expect(text).toContain('"prompt_tokens":11');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("omits the usage chunk unless the client asked for it", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", stream: true, messages: [] })
    });

    const text = await readSseText(response);
    // Real OpenAI only sends it with stream_options.include_usage, and plenty
    // of client code reads choices[0] without guarding against an empty array.
    expect(text).not.toContain('"usage"');
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("forwards upstream pings so a thinking stream does not look idle", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"type":"ping"}',
          'data: {"type":"content_block_delta","index":0,"delta":{"text":"ok"}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", stream: true, messages: [] })
    });

    expect(await readSseText(response)).toContain(": keep-alive");
  });

  it("sets a content-type on the relayed stream", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse(['data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}']));
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", stream: true, messages: [] })
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.text();
  });
});

describe("Gemini streaming translation", () => {
  it("converts functionCall parts into OpenAI tool calls", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":9}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "gemini" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-test",
        stream: true,
        stream_options: { include_usage: true },
        messages: []
      })
    });

    const text = await readSseText(response);
    expect(text).toContain('"name":"lookup"');
    expect(text).toContain('{\\"q\\":\\"x\\"}');
    expect(text).toContain('"completion_tokens":9');
  });
});

describe("Responses streaming translation", () => {
  it("uses contiguous output indices and Responses usage keys for a tool-only turn", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"apply_patch"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":13}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", stream: true, input: "patch it" })
    });

    const text = await readSseText(response);

    // No message item exists on a tool-only turn, so the tool call must be at
    // index 0 to match its position in the final output array.
    expect(text).toContain('"output_index":0');
    expect(text).not.toContain('"output_index":1');
    // Responses names usage differently from Chat Completions.
    expect(text).toContain('"output_tokens":13');
    expect(text).toContain('"input_tokens":7');
    expect(text).not.toContain('"completion_tokens"');
  });
});

describe("chunk pacing", () => {
  it("measures generated text rather than the SSE envelope", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"abcde"}}]}',
          "data: [DONE]"
        ])
      );
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [] })
    });
    await response.text();

    const chunks = eventsOfType(proxy.bus, "response.chunk");
    expect(chunks).toHaveLength(1);
    // "abcde" is 5 chars; the raw frame is far longer.
    expect(chunks[0]).toMatchObject({ chars: 5 });
  });

  it("counts streamed tool-call arguments as output", async () => {
    const args = '{"path":"src/index.ts"}';
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(args)}}}]}}]}`,
          "data: [DONE]"
        ])
      );
    });
    const proxy = await createProxy(upstream);

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [] })
    });
    await response.text();

    // An agent turn is often mostly tool arguments; scoring those as zero would
    // flatten the feedback through exactly the phase that matters most.
    const chunks = eventsOfType(proxy.bus, "response.chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chars: args.length });
  });

  it("counts Anthropic tool-argument and thinking deltas", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"12345"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"abc"}}'
        ])
      );
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", stream: true, messages: [] })
    });
    await response.text();

    const chunks = eventsOfType(proxy.bus, "response.chunk") as Array<{ chars: number }>;
    expect(chunks.map((chunk) => chunk.chars)).toEqual([5, 3]);
  });
});

describe("request validation", () => {
  it("answers 400 when Fastify's JSON parser rejects the body", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });

    expect(response.status).toBe(400);
  });

  it("answers 400 for malformed bodies that reach the buffer parser", async () => {
    const upstream = await createMockUpstream((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    // A non-JSON content-type bypasses Fastify's own parser and lands in the
    // catch-all buffer parser, where the translator does the JSON parsing.
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not json"
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("Responses translation", () => {
  it("keeps flat Responses tools and tool results", async () => {
    let received: Record<string, unknown> = {};
    const upstream = await createMockUpstream((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }));
      });
    });
    const proxy = await createProxy(upstream, { protocol: "anthropic" });

    await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
        input: [
          { role: "user", content: "find it" },
          { type: "function_call_output", call_id: "call_1", output: "result text" }
        ]
      })
    });

    expect(received.tools).toMatchObject([{ name: "search" }]);
    const messages = received.messages as Array<{ role: string; content: unknown }>;
    // The tool result must survive as a message rather than vanishing.
    expect(JSON.stringify(messages)).toContain("result text");
  });
});
