import type { AppConfig } from "../config/schema.js";
import { SseParser } from "./sse.js";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface UpstreamRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  signal?: AbortSignal;
}

type UpstreamConfig = AppConfig["upstream"];
type ChatEndpoint = "chat" | "responses";

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  stop?: string | string[];
  tools?: OpenAiTool[];
  tool_choice?: unknown;
  input?: unknown;
  instructions?: unknown;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
}

interface OpenAiTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

interface NativeTextResponse {
  text: string;
  model?: string;
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export class UpstreamClient {
  constructor(private readonly config: UpstreamConfig) {}

  async request(input: UpstreamRequest): Promise<Response> {
    const endpoint = detectChatEndpoint(input.path);
    if (this.config.protocol === "openai" || !endpoint || input.method.toUpperCase() !== "POST") {
      return this.passThrough(input);
    }

    const body = parseRequestBody(input.body);
    const chatBody = endpoint === "responses" ? responsesToChatBody(body) : body;

    if (this.config.protocol === "anthropic") {
      return this.requestAnthropic(input, chatBody, endpoint);
    }
    return this.requestGemini(input, chatBody, endpoint);
  }

  private async passThrough(input: UpstreamRequest): Promise<Response> {
    const url = new URL(input.path + input.query, normalizedBaseUrl(this.config.base_url));
    const headers = copyClientHeaders(input.headers);

    if (!headers.has("authorization")) {
      const apiKey = resolveApiKey(this.config);
      if (apiKey) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
    }

    return fetchWithTimeout(url, input, headers, this.config.timeout_ms);
  }

  private async requestAnthropic(input: UpstreamRequest, body: ChatRequest, endpoint: ChatEndpoint): Promise<Response> {
    const url = new URL("v1/messages", normalizedBaseUrl(this.config.base_url));
    const apiKey = resolveApiKey(this.config);
    const headers = new Headers({
      "content-type": "application/json",
      accept: body.stream ? "text/event-stream" : "application/json",
      "anthropic-version": this.config.anthropic_version
    });
    if (apiKey) {
      headers.set("x-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(
      url,
      { ...input, body: Buffer.from(JSON.stringify(toAnthropicRequest(body))) },
      headers,
      this.config.timeout_ms
    );

    if (!upstream.ok) {
      return upstream;
    }
    if (body.stream) {
      return transformAnthropicStream(upstream, body, endpoint);
    }
    const native = anthropicToTextResponse((await upstream.json()) as Record<string, unknown>, body.model);
    return jsonResponse(endpoint === "chat" ? toOpenAiChatResponse(native) : toOpenAiResponsesResponse(native));
  }

  private async requestGemini(input: UpstreamRequest, body: ChatRequest, endpoint: ChatEndpoint): Promise<Response> {
    const model = body.model ?? "gemini-2.0-flash";
    const action = body.stream ? "streamGenerateContent" : "generateContent";
    const url = new URL(`models/${encodeURIComponent(model)}:${action}`, normalizedBaseUrl(this.config.base_url));
    if (body.stream) {
      url.searchParams.set("alt", "sse");
    }

    const apiKey = resolveApiKey(this.config);
    const headers = new Headers({
      "content-type": "application/json",
      accept: body.stream ? "text/event-stream" : "application/json"
    });
    if (apiKey) {
      headers.set("x-goog-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(
      url,
      { ...input, body: Buffer.from(JSON.stringify(toGeminiRequest(body))) },
      headers,
      this.config.timeout_ms
    );

    if (!upstream.ok) {
      return upstream;
    }
    if (body.stream) {
      return transformGeminiStream(upstream, body, endpoint);
    }
    const native = geminiToTextResponse((await upstream.json()) as Record<string, unknown>, body.model);
    return jsonResponse(endpoint === "chat" ? toOpenAiChatResponse(native) : toOpenAiResponsesResponse(native));
  }
}

function detectChatEndpoint(path: string): ChatEndpoint | undefined {
  if (path === "/v1/chat/completions") return "chat";
  if (path === "/v1/responses") return "responses";
  return undefined;
}

function copyClientHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower) || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function fetchWithTimeout(
  url: URL,
  input: Pick<UpstreamRequest, "method" | "body" | "signal">,
  headers: Headers,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const body = input.body ? new Uint8Array(input.body) : undefined;
  try {
    return await fetch(url, {
      method: input.method,
      headers,
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRequestBody(body: Buffer | undefined): ChatRequest {
  if (!body || body.byteLength === 0) {
    return {};
  }
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  return isRecord(parsed) ? (parsed as ChatRequest) : {};
}

function responsesToChatBody(body: ChatRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item)) {
        const role = typeof item.role === "string" ? item.role : "user";
        messages.push({ role, content: item.content });
      }
    }
  }

  return {
    ...body,
    messages: messages.length > 0 ? messages : body.messages,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    stream: body.stream === true
  };
}

function toAnthropicRequest(body: ChatRequest): Record<string, unknown> {
  const system = collectSystemText(body.messages);
  const request: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 4096,
    messages: mergeAdjacentMessages(
      (body.messages ?? [])
        .filter((message) => message.role !== "system" && message.role !== "developer")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: toAnthropicContent(message)
        }))
    ),
    stream: body.stream === true
  };

  if (system) request.system = system;
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  const stopSequences = normalizeStop(body.stop);
  if (stopSequences) request.stop_sequences = stopSequences;
  const tools = toAnthropicTools(body.tools);
  if (tools.length > 0) request.tools = tools;
  const toolChoice = toAnthropicToolChoice(body.tool_choice);
  if (toolChoice) request.tool_choice = toolChoice;
  return request;
}

function toGeminiRequest(body: ChatRequest): Record<string, unknown> {
  const system = collectSystemText(body.messages);
  const request: Record<string, unknown> = {
    contents: mergeAdjacentGeminiContents(
      (body.messages ?? [])
        .filter((message) => message.role !== "system" && message.role !== "developer")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: toGeminiParts(message)
        }))
    )
  };

  if (system) request.systemInstruction = { parts: [{ text: system }] };

  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
  if (typeof maxTokens === "number") generationConfig.maxOutputTokens = maxTokens;
  const stopSequences = normalizeStop(body.stop);
  if (stopSequences) generationConfig.stopSequences = stopSequences;
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  const tools = toGeminiTools(body.tools);
  if (tools.length > 0) request.tools = tools;
  return request;
}

function collectSystemText(messages: ChatMessage[] | undefined): string | undefined {
  const text = (messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => contentTextParts(message.content))
    .join("\n")
    .trim();
  return text || undefined;
}

function toAnthropicContent(message: ChatMessage): Array<Record<string, string>> {
  const parts = contentTextParts(message.content);
  const text = parts.length > 0 ? parts : [fallbackMessageText(message)];
  return text.map((item) => ({ type: "text", text: item }));
}

function toGeminiParts(message: ChatMessage): Array<Record<string, string>> {
  const parts = contentTextParts(message.content);
  const text = parts.length > 0 ? parts : [fallbackMessageText(message)];
  return text.map((item) => ({ text: item }));
}

function contentTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
    } else if (typeof item.type === "string" && typeof item.content === "string") {
      parts.push(item.content);
    }
  }
  return parts;
}

function fallbackMessageText(message: ChatMessage): string {
  if (message.role === "tool") {
    return `[tool:${message.name ?? message.tool_call_id ?? "result"}]`;
  }
  return "";
}

function mergeAdjacentMessages(
  messages: Array<{ role: string; content: Array<Record<string, string>> }>
): Array<{ role: string; content: Array<Record<string, string>> }> {
  const merged: Array<{ role: string; content: Array<Record<string, string>> }> = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged.length > 0 ? merged : [{ role: "user", content: [{ type: "text", text: "" }] }];
}

function mergeAdjacentGeminiContents(
  contents: Array<{ role: string; parts: Array<Record<string, string>> }>
): Array<{ role: string; parts: Array<Record<string, string>> }> {
  const merged: Array<{ role: string; parts: Array<Record<string, string>> }> = [];
  for (const content of contents) {
    const previous = merged.at(-1);
    if (previous?.role === content.role) {
      previous.parts.push(...content.parts);
    } else {
      merged.push({ role: content.role, parts: [...content.parts] });
    }
  }
  return merged.length > 0 ? merged : [{ role: "user", parts: [{ text: "" }] }];
}

function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (typeof stop === "string") return [stop];
  if (Array.isArray(stop) && stop.every((item) => typeof item === "string")) return stop;
  return undefined;
}

function toAnthropicTools(tools: OpenAiTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? [])
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function?.name,
      description: tool.function?.description,
      input_schema: tool.function?.parameters ?? { type: "object", properties: {} }
    }));
}

function toGeminiTools(tools: OpenAiTool[] | undefined): Array<Record<string, unknown>> {
  const declarations = (tools ?? [])
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function?.name,
      description: tool.function?.description,
      parameters: tool.function?.parameters ?? { type: "object", properties: {} }
    }));
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

function toAnthropicToolChoice(toolChoice: unknown): Record<string, unknown> | undefined {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (isRecord(toolChoice) && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
    return { type: "tool", name: toolChoice.function.name };
  }
  return undefined;
}

function anthropicToTextResponse(payload: Record<string, unknown>, fallbackModel?: string): NativeTextResponse {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("");
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  return {
    text,
    model: typeof payload.model === "string" ? payload.model : fallbackModel,
    finishReason: mapAnthropicFinish(typeof payload.stop_reason === "string" ? payload.stop_reason : undefined),
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  };
}

function geminiToTextResponse(payload: Record<string, unknown>, fallbackModel?: string): NativeTextResponse {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isRecord) : [];
  const first = candidates[0];
  const content = first && isRecord(first.content) ? first.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
  return {
    text,
    model: fallbackModel,
    finishReason: mapGeminiFinish(first && typeof first.finishReason === "string" ? first.finishReason : undefined),
    promptTokens: readNumber(usage.promptTokenCount),
    completionTokens: readNumber(usage.candidatesTokenCount),
    totalTokens: readNumber(usage.totalTokenCount)
  };
}

function toOpenAiChatResponse(native: NativeTextResponse): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    created: nowSeconds(),
    model: native.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: native.text },
        finish_reason: native.finishReason ?? "stop"
      }
    ],
    usage: toOpenAiUsage(native)
  };
}

function toOpenAiResponsesResponse(native: NativeTextResponse): Record<string, unknown> {
  const id = `resp_${randomId()}`;
  return {
    id,
    object: "response",
    created_at: nowSeconds(),
    status: "completed",
    model: native.model,
    output_text: native.text,
    output: [
      {
        id: `msg_${randomId()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: native.text, annotations: [] }]
      }
    ],
    usage: toOpenAiUsage(native)
  };
}

function toOpenAiUsage(native: NativeTextResponse): Record<string, number | undefined> {
  return {
    prompt_tokens: native.promptTokens,
    completion_tokens: native.completionTokens,
    total_tokens: native.totalTokens
  };
}

function transformAnthropicStream(upstream: Response, body: ChatRequest, endpoint: ChatEndpoint): Response {
  const id = endpoint === "chat" ? `chatcmpl-${randomId()}` : `resp_${randomId()}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      const parser = new SseParser();
      const reader = upstream.body?.getReader();
      if (!reader) {
        writer.done(endpoint);
        controller.close();
        return;
      }

      try {
        if (endpoint === "responses") {
          writer.responseCreated(id, body.model);
        } else {
          writer.chatChunk(id, body.model, { role: "assistant" });
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.feed(value)) {
            if (!event.data || event.data === "[DONE]") continue;
            const payload = safeJson(event.data);
            if (!isRecord(payload)) continue;
            const text = readAnthropicStreamText(payload);
            if (text) writer.textDelta(endpoint, id, body.model, text);
          }
        }

        for (const event of parser.end()) {
          if (!event.data || event.data === "[DONE]") continue;
          const payload = safeJson(event.data);
          if (!isRecord(payload)) continue;
          const text = readAnthropicStreamText(payload);
          if (text) writer.textDelta(endpoint, id, body.model, text);
        }

        writer.completed(endpoint, id, body.model);
        writer.done(endpoint);
      } catch (error) {
        writer.error(error instanceof Error ? error.message : String(error));
      } finally {
        controller.close();
      }
    }
  });
  return sseResponse(stream);
}

function transformGeminiStream(upstream: Response, body: ChatRequest, endpoint: ChatEndpoint): Response {
  const id = endpoint === "chat" ? `chatcmpl-${randomId()}` : `resp_${randomId()}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      const parser = new SseParser();
      const reader = upstream.body?.getReader();
      if (!reader) {
        writer.done(endpoint);
        controller.close();
        return;
      }

      try {
        if (endpoint === "responses") {
          writer.responseCreated(id, body.model);
        } else {
          writer.chatChunk(id, body.model, { role: "assistant" });
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.feed(value)) {
            if (!event.data || event.data === "[DONE]") continue;
            const payload = safeJson(event.data);
            if (!isRecord(payload)) continue;
            const text = geminiToTextResponse(payload, body.model).text;
            if (text) writer.textDelta(endpoint, id, body.model, text);
          }
        }

        writer.completed(endpoint, id, body.model);
        writer.done(endpoint);
      } catch (error) {
        writer.error(error instanceof Error ? error.message : String(error));
      } finally {
        controller.close();
      }
    }
  });
  return sseResponse(stream);
}

class SseWriter {
  private readonly encoder = new TextEncoder();
  private readonly responseItemId = `msg_${randomId()}`;

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  chatChunk(id: string, model: string | undefined, delta: Record<string, unknown>, finishReason: string | null = null): void {
    this.writeData({
      id,
      object: "chat.completion.chunk",
      created: nowSeconds(),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    });
  }

  responseCreated(id: string, model: string | undefined): void {
    this.writeEvent("response.created", {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: nowSeconds(),
        status: "in_progress",
        model,
        output: []
      }
    });
  }

  textDelta(endpoint: ChatEndpoint, id: string, model: string | undefined, text: string): void {
    if (endpoint === "chat") {
      this.chatChunk(id, model, { content: text });
      return;
    }
    this.writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.responseItemId,
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }

  completed(endpoint: ChatEndpoint, id: string, model: string | undefined): void {
    if (endpoint === "chat") {
      this.chatChunk(id, model, {}, "stop");
      return;
    }
    this.writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id,
        object: "response",
        created_at: nowSeconds(),
        status: "completed",
        model,
        output: []
      }
    });
  }

  done(endpoint: ChatEndpoint): void {
    if (endpoint === "chat") {
      this.writeRaw("data: [DONE]\n\n");
    }
  }

  error(message: string): void {
    this.writeEvent("error", { type: "error", error: { message } });
  }

  private writeData(payload: Record<string, unknown>): void {
    this.writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private writeEvent(event: string, payload: Record<string, unknown>): void {
    this.writeRaw(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private writeRaw(value: string): void {
    this.controller.enqueue(this.encoder.encode(value));
  }
}

function readAnthropicStreamText(payload: Record<string, unknown>): string | undefined {
  if (payload.type !== "content_block_delta" || !isRecord(payload.delta)) {
    return undefined;
  }
  return typeof payload.delta.text === "string" ? payload.delta.text : undefined;
}

function mapAnthropicFinish(reason: string | undefined): string | null {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "stop_sequence" || reason === "end_turn") return "stop";
  return reason ?? null;
}

function mapGeminiFinish(reason: string | undefined): string | null {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  if (reason === "STOP") return "stop";
  return reason ?? null;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function resolveApiKey(config: UpstreamConfig): string | undefined {
  return config.api_key || process.env[config.api_key_env];
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
