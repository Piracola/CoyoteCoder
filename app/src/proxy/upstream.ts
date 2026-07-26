import type { AppConfig } from "../config/schema.js";
import { SseParser } from "./sse.js";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

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
type TextEndpoint = "chat" | "responses" | "completions";
type ChatEndpoint = Exclude<TextEndpoint, "completions">;

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
  stream_options?: { include_usage?: boolean };
}

interface CompletionRequest {
  model?: string;
  prompt?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  stop?: string | string[];
}

interface EmbeddingRequest {
  model?: string;
  input?: unknown;
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

interface NativeToolCall {
  id: string;
  name: string;
  /** Raw JSON string, matching OpenAI's function.arguments. */
  arguments: string;
}

interface NativeTextResponse {
  text: string;
  model?: string;
  finishReason?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: NativeToolCall[];
}

interface OpenAiModelSummary {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface FetchInitWithDispatcher {
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal: AbortSignal;
  dispatcher?: Dispatcher;
}

// Anthropic requires max_tokens and rejects a value above the model's ceiling
// (claude-3-opus caps at 4096). This only applies when the client omitted one
// entirely, so it must be low enough to be valid for every model.
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

let envProxyAgent: EnvHttpProxyAgent | undefined;

export class UpstreamClient {
  constructor(private readonly config: UpstreamConfig) {}

  async request(input: UpstreamRequest): Promise<Response> {
    const compatInput = { ...input, path: openAiCompatiblePath(input.path) };

    if (this.config.protocol === "openai") {
      if (compatInput.method.toUpperCase() === "GET" && (compatInput.path === "/v1/models" || detectModelRetrieve(compatInput.path))) {
        return this.passThroughOpenAiModelRequest(compatInput);
      }
      return this.passThrough(compatInput);
    }

    if (compatInput.method.toUpperCase() === "GET" && compatInput.path === "/v1/models") {
      return this.listModels(compatInput);
    }

    const modelId = detectModelRetrieve(compatInput.path);
    if (compatInput.method.toUpperCase() === "GET" && modelId) {
      return this.retrieveModel(compatInput, modelId);
    }

    const endpoint = detectChatEndpoint(compatInput.path);
    if (endpoint && compatInput.method.toUpperCase() === "POST") {
      const body = parseRequestBody(input.body);
      const chatBody = endpoint === "responses" ? responsesToChatBody(body) : body;

      if (this.config.protocol === "anthropic") {
        return this.requestAnthropic(compatInput, chatBody, endpoint);
      }
      return this.requestGemini(compatInput, chatBody, endpoint);
    }

    if (compatInput.path === "/v1/completions" && compatInput.method.toUpperCase() === "POST") {
      return this.requestCompletion(compatInput, parseCompletionBody(input.body));
    }

    if (compatInput.path === "/v1/embeddings" && compatInput.method.toUpperCase() === "POST") {
      if (this.config.protocol === "gemini") {
        return this.requestGeminiEmbeddings(compatInput, parseEmbeddingBody(input.body));
      }
      return unsupportedResponse("anthropic", compatInput.path);
    }

    return this.passThroughNative(input);
  }

  private async passThrough(input: UpstreamRequest): Promise<Response> {
    const url = new URL(input.path + input.query, normalizedBaseUrl(this.config.base_url));
    const headers = copyClientHeaders(input.headers);

    const apiKey = resolveApiKey(this.config, input.headers);
    if (apiKey) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }

    return fetchWithTimeout(url, input, headers, this.config.timeout_ms);
  }

  private async passThroughOpenAiModelRequest(input: UpstreamRequest): Promise<Response> {
    const upstream = await this.passThrough(input);
    if (!upstream.ok || !isJsonResponse(upstream)) {
      return upstream;
    }

    const payload = safeJson(await upstream.clone().text());
    if (!isRecord(payload)) {
      return upstream;
    }

    if (input.path === "/v1/models" && Array.isArray(payload.data)) {
      return jsonResponse(toOpenAiModelsResponse(payload.data));
    }

    if (detectModelRetrieve(input.path) && typeof payload.id === "string" && payload.object !== "model") {
      const compatiblePayload = { object: "model", ...payload };
      compatiblePayload.object = "model";
      return jsonResponse(compatiblePayload);
    }

    return upstream;
  }

  private async passThroughNative(input: UpstreamRequest): Promise<Response> {
    const path = this.config.protocol === "gemini" ? geminiNativePath(input.path) : input.path;
    const url = new URL(path + input.query, normalizedBaseUrl(this.config.base_url));
    const headers = copyClientHeaders(input.headers);
    headers.delete("authorization");

    const apiKey = resolveApiKey(this.config, input.headers);
    if (this.config.protocol === "anthropic") {
      if (apiKey && !headers.has("x-api-key")) {
        headers.set("x-api-key", apiKey);
      }
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", this.config.anthropic_version);
      }
    } else if (apiKey && !headers.has("x-goog-api-key")) {
      headers.set("x-goog-api-key", apiKey);
    }

    return fetchWithTimeout(url, input, headers, this.config.timeout_ms);
  }

  private async listModels(input: UpstreamRequest): Promise<Response> {
    if (this.config.protocol === "anthropic") {
      return this.listAnthropicModels(input);
    }
    return this.listGeminiModels(input);
  }

  private async retrieveModel(input: UpstreamRequest, modelId: string): Promise<Response> {
    if (this.config.protocol === "anthropic") {
      return this.retrieveAnthropicModel(input, modelId);
    }
    return this.retrieveGeminiModel(input, modelId);
  }

  private async listAnthropicModels(input: UpstreamRequest): Promise<Response> {
    const url = new URL("v1/models" + input.query, normalizedBaseUrl(this.config.base_url));
    const headers = new Headers({
      accept: "application/json",
      "anthropic-version": this.config.anthropic_version
    });
    const apiKey = resolveApiKey(this.config, input.headers);
    if (apiKey) {
      headers.set("x-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(url, { ...input, body: undefined }, headers, this.config.timeout_ms);
    if (!upstream.ok) {
      return upstream;
    }
    return jsonResponse(toOpenAiModelsResponse(anthropicModelsToOpenAi((await upstream.json()) as unknown)));
  }

  private async retrieveAnthropicModel(input: UpstreamRequest, modelId: string): Promise<Response> {
    const url = new URL(`v1/models/${encodeURIComponent(modelId)}`, normalizedBaseUrl(this.config.base_url));
    const headers = new Headers({
      accept: "application/json",
      "anthropic-version": this.config.anthropic_version
    });
    const apiKey = resolveApiKey(this.config, input.headers);
    if (apiKey) {
      headers.set("x-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(url, { ...input, body: undefined }, headers, this.config.timeout_ms);
    if (!upstream.ok) {
      return upstream;
    }
    const models = anthropicModelsToOpenAi({ data: [(await upstream.json()) as unknown] });
    return models[0] ? jsonResponse(models[0]) : upstream;
  }

  private async listGeminiModels(input: UpstreamRequest): Promise<Response> {
    const url = new URL("models" + input.query, normalizedBaseUrl(this.config.base_url));
    const headers = new Headers({ accept: "application/json" });
    const apiKey = resolveApiKey(this.config, input.headers);
    if (apiKey) {
      headers.set("x-goog-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(url, { ...input, body: undefined }, headers, this.config.timeout_ms);
    if (!upstream.ok) {
      return upstream;
    }
    return jsonResponse(toOpenAiModelsResponse(geminiModelsToOpenAi((await upstream.json()) as unknown)));
  }

  private async retrieveGeminiModel(input: UpstreamRequest, modelId: string): Promise<Response> {
    const url = new URL(geminiModelPath(modelId), normalizedBaseUrl(this.config.base_url));
    const headers = new Headers({ accept: "application/json" });
    const apiKey = resolveApiKey(this.config, input.headers);
    if (apiKey) {
      headers.set("x-goog-api-key", apiKey);
    }

    const upstream = await fetchWithTimeout(url, { ...input, body: undefined }, headers, this.config.timeout_ms);
    if (!upstream.ok) {
      return upstream;
    }
    const models = geminiModelsToOpenAi({ models: [(await upstream.json()) as unknown] });
    return models[0] ? jsonResponse(models[0]) : upstream;
  }

  private async requestAnthropic(input: UpstreamRequest, body: ChatRequest, endpoint: TextEndpoint): Promise<Response> {
    const url = new URL("v1/messages", normalizedBaseUrl(this.config.base_url));
    const apiKey = resolveApiKey(this.config, input.headers);
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
    return jsonResponse(toOpenAiTextResponse(native, endpoint));
  }

  private async requestGemini(input: UpstreamRequest, body: ChatRequest, endpoint: TextEndpoint): Promise<Response> {
    const model = body.model ?? "gemini-2.0-flash";
    const action = body.stream ? "streamGenerateContent" : "generateContent";
    const url = new URL(`${geminiModelPath(model)}:${action}`, normalizedBaseUrl(this.config.base_url));
    if (body.stream) {
      url.searchParams.set("alt", "sse");
    }

    const apiKey = resolveApiKey(this.config, input.headers);
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
    return jsonResponse(toOpenAiTextResponse(native, endpoint));
  }

  private async requestCompletion(input: UpstreamRequest, body: CompletionRequest): Promise<Response> {
    const chatBody = completionToChatBody(body);
    if (this.config.protocol === "anthropic") {
      const upstream = await this.requestAnthropic(input, chatBody, "completions");
      return upstream;
    }
    return this.requestGemini(input, chatBody, "completions");
  }

  private async requestGeminiEmbeddings(input: UpstreamRequest, body: EmbeddingRequest): Promise<Response> {
    const model = body.model ?? "text-embedding-004";
    const inputs = normalizeEmbeddingInputs(body.input);
    const apiKey = resolveApiKey(this.config, input.headers);
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json"
    });
    if (apiKey) {
      headers.set("x-goog-api-key", apiKey);
    }

    if (inputs.length <= 1) {
      const url = new URL(`${geminiModelPath(model)}:embedContent`, normalizedBaseUrl(this.config.base_url));
      const upstream = await fetchWithTimeout(
        url,
        {
          ...input,
          body: Buffer.from(JSON.stringify({ content: { parts: [{ text: inputs[0] ?? "" }] } }))
        },
        headers,
        this.config.timeout_ms
      );
      if (!upstream.ok) {
        return upstream;
      }
      return jsonResponse(toOpenAiEmbeddingsResponse([(await upstream.json()) as unknown], model));
    }

    const url = new URL(`${geminiModelPath(model)}:batchEmbedContents`, normalizedBaseUrl(this.config.base_url));
    const upstream = await fetchWithTimeout(
      url,
      {
        ...input,
        body: Buffer.from(
          JSON.stringify({
            requests: inputs.map((text) => ({
              model: geminiModelPath(model),
              content: { parts: [{ text }] }
            }))
          })
        )
      },
      headers,
      this.config.timeout_ms
    );
    if (!upstream.ok) {
      return upstream;
    }
    const payload = (await upstream.json()) as unknown;
    const embeddings = isRecord(payload) && Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return jsonResponse(toOpenAiEmbeddingsResponse(embeddings, model));
  }
}

function detectChatEndpoint(path: string): ChatEndpoint | undefined {
  if (path === "/v1/chat/completions") return "chat";
  if (path === "/v1/responses") return "responses";
  return undefined;
}

function detectModelRetrieve(path: string): string | undefined {
  const match = path.match(/^\/v1\/models\/([^/?]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function openAiCompatiblePath(path: string): string {
  if (path === "/models") {
    return "/v1/models";
  }
  const match = path.match(/^\/models\/([^/?]+)$/);
  return match ? `/v1/models/${match[1]}` : path;
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
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });

  const body = input.body ? new Uint8Array(input.body) : undefined;
  try {
    const init: FetchInitWithDispatcher = {
      method: input.method,
      headers,
      body,
      signal: controller.signal,
      dispatcher: envProxyDispatcher(url)
    };
    return (await undiciFetch(url, init as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } finally {
    // Only the connect phase is bounded here; the streaming body is guarded by
    // the idle timeout in the SSE relay.
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

function envProxyDispatcher(url: URL): Dispatcher | undefined {
  if (isLocalAddress(url.hostname) || !hasProxyEnv(url.protocol)) {
    return undefined;
  }
  envProxyAgent ??= new EnvHttpProxyAgent();
  return envProxyAgent;
}

function hasProxyEnv(protocol: string): boolean {
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? httpProxy;
  return protocol === "https:" ? Boolean(httpsProxy) : Boolean(httpProxy);
}

function isLocalAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith(".localhost");
}

/** Malformed client input; the proxy answers 400 rather than a 502. */
export class UpstreamRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

function parseJsonRequestBody<T>(body: Buffer | undefined): T {
  if (!body || body.byteLength === 0) {
    return {} as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    throw new UpstreamRequestError(`invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`);
  }
  return isRecord(parsed) ? (parsed as T) : ({} as T);
}

function parseRequestBody(body: Buffer | undefined): ChatRequest {
  return parseJsonRequestBody<ChatRequest>(body);
}

function parseCompletionBody(body: Buffer | undefined): CompletionRequest {
  return parseJsonRequestBody<CompletionRequest>(body);
}

function parseEmbeddingBody(body: Buffer | undefined): EmbeddingRequest {
  return parseJsonRequestBody<EmbeddingRequest>(body);
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
      if (!isRecord(item)) {
        continue;
      }

      // Responses encodes a tool result as a standalone item rather than a
      // message; dropping it silently breaks multi-turn tool loops.
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          tool_call_id: typeof item.call_id === "string" ? item.call_id : undefined
        });
        continue;
      }

      // An assistant's own tool call replayed as conversation history.
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: typeof item.name === "string" ? `[tool_call:${item.name}] ${stringifyArguments(item.arguments)}` : ""
        });
        continue;
      }

      const role = typeof item.role === "string" ? item.role : "user";
      messages.push({ role, content: item.content });
    }
  }

  return {
    ...body,
    messages: messages.length > 0 ? messages : body.messages,
    // Responses uses a flat tool shape; normalize it so the Anthropic and
    // Gemini converters (which expect tool.function.name) still see them.
    tools: normalizeResponsesTools(body.tools),
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    stream: body.stream === true
  };
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? "" : JSON.stringify(value);
}

/**
 * Accepts both the chat shape ({type:"function", function:{name,...}}) and the
 * Responses shape ({type:"function", name, parameters}).
 */
function normalizeResponsesTools(tools: OpenAiTool[] | undefined): OpenAiTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }

  const normalized: OpenAiTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    if (tool.function && isRecord(tool.function)) {
      normalized.push(tool);
      continue;
    }
    const flat = tool as unknown as Record<string, unknown>;
    if (typeof flat.name === "string") {
      normalized.push({
        type: "function",
        function: {
          name: flat.name,
          description: typeof flat.description === "string" ? flat.description : undefined,
          parameters: flat.parameters
        }
      });
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function completionToChatBody(body: CompletionRequest): ChatRequest {
  return {
    model: body.model,
    messages: [{ role: "user", content: promptToText(body.prompt) }],
    stream: body.stream === true,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
    stop: body.stop
  };
}

function promptToText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    if (prompt.every((item) => typeof item === "string")) {
      return prompt.join("\n");
    }
    if (prompt.every((item) => typeof item === "number")) {
      return prompt.join(" ");
    }
  }
  return "";
}

function toAnthropicRequest(body: ChatRequest): Record<string, unknown> {
  const system = collectSystemText(body.messages);
  const request: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
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
    } else if (typeof item.type === "string" && NON_TEXT_CONTENT_TYPES.has(item.type)) {
      // These translators are text-only. Leave a visible marker so the model
      // is told something was omitted rather than silently losing the part.
      parts.push(`[${item.type} omitted by CoyoteCoder text-only translation]`);
    }
  }
  return parts;
}

const NON_TEXT_CONTENT_TYPES = new Set([
  "image_url",
  "input_image",
  "input_audio",
  "input_file",
  "image",
  "audio",
  "document"
]);

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
  const content = Array.isArray(payload.content) ? payload.content.filter(isRecord) : [];
  const text = content.map((item) => (typeof item.text === "string" ? item.text : "")).join("");
  const toolCalls: NativeToolCall[] = [];
  for (const item of content) {
    if (item.type !== "tool_use" || typeof item.name !== "string") {
      continue;
    }
    toolCalls.push({
      id: typeof item.id === "string" ? item.id : `call_${randomId()}`,
      name: item.name,
      arguments: JSON.stringify(item.input ?? {})
    });
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  return {
    text,
    model: typeof payload.model === "string" ? payload.model : fallbackModel,
    finishReason: mapAnthropicFinish(typeof payload.stop_reason === "string" ? payload.stop_reason : undefined),
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
  };
}

function geminiToTextResponse(payload: Record<string, unknown>, fallbackModel?: string): NativeTextResponse {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isRecord) : [];
  const first = candidates[0];
  const content = first && isRecord(first.content) ? first.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  const toolCalls: NativeToolCall[] = [];
  for (const part of parts) {
    if (!isRecord(part.functionCall) || typeof part.functionCall.name !== "string") {
      continue;
    }
    toolCalls.push({
      id: `call_${randomId()}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {})
    });
  }
  const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
  return {
    text,
    model: fallbackModel,
    finishReason: mapGeminiFinish(first && typeof first.finishReason === "string" ? first.finishReason : undefined),
    promptTokens: readNumber(usage.promptTokenCount),
    completionTokens: readNumber(usage.candidatesTokenCount),
    totalTokens: readNumber(usage.totalTokenCount),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
  };
}

function toOpenAiChatResponse(native: NativeTextResponse): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    // OpenAI sends content: null alongside tool calls rather than an empty string.
    content: native.toolCalls && !native.text ? null : native.text
  };
  if (native.toolCalls) {
    message.tool_calls = native.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }));
  }

  return {
    id: `chatcmpl-${randomId()}`,
    object: "chat.completion",
    created: nowSeconds(),
    model: native.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: native.finishReason ?? (native.toolCalls ? "tool_calls" : "stop")
      }
    ],
    usage: toOpenAiUsage(native)
  };
}

function toOpenAiTextResponse(native: NativeTextResponse, endpoint: TextEndpoint): Record<string, unknown> {
  if (endpoint === "chat") {
    return toOpenAiChatResponse(native);
  }
  if (endpoint === "responses") {
    return toOpenAiResponsesResponse(native);
  }
  return toOpenAiCompletionResponse(native);
}

function toOpenAiCompletionResponse(native: NativeTextResponse): Record<string, unknown> {
  return {
    id: `cmpl-${randomId()}`,
    object: "text_completion",
    created: nowSeconds(),
    model: native.model,
    choices: [
      {
        text: native.text,
        index: 0,
        logprobs: null,
        finish_reason: native.finishReason ?? "stop"
      }
    ],
    usage: toOpenAiUsage(native)
  };
}

function toOpenAiResponsesResponse(native: NativeTextResponse): Record<string, unknown> {
  const id = `resp_${randomId()}`;
  const output: Record<string, unknown>[] = [];

  if (native.text) {
    output.push({
      id: `msg_${randomId()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: native.text, annotations: [] }]
    });
  }
  // Responses represents tool calls as flat function_call items, not as a
  // tool_calls array hanging off a message.
  for (const call of native.toolCalls ?? []) {
    output.push({
      id: `fc_${randomId()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments
    });
  }

  return {
    id,
    object: "response",
    created_at: nowSeconds(),
    status: "completed",
    model: native.model,
    output_text: native.text,
    output,
    usage: toResponsesUsage(native.promptTokens ?? 0, native.completionTokens ?? 0, native.totalTokens)
  };
}

function toOpenAiEmbeddingsResponse(embeddings: unknown[], model: string): Record<string, unknown> {
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding: readGeminiEmbeddingValues(embedding),
      index
    })),
    model,
    usage: {
      prompt_tokens: 0,
      total_tokens: 0
    }
  };
}

function toOpenAiUsage(native: NativeTextResponse): Record<string, number> {
  // Undefined members would be dropped by JSON.stringify and leave clients with
  // a malformed usage object, so fall back to zeros.
  const promptTokens = native.promptTokens ?? 0;
  const completionTokens = native.completionTokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: native.totalTokens ?? promptTokens + completionTokens
  };
}

/** Responses names its usage fields differently from Chat Completions. */
function toResponsesUsage(promptTokens: number, completionTokens: number, totalTokens?: number): Record<string, number> {
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens ?? promptTokens + completionTokens
  };
}

function toOpenAiModelsResponse(data: OpenAiModelSummary[]): Record<string, unknown> {
  return {
    object: "list",
    data
  };
}

function anthropicModelsToOpenAi(payload: unknown): OpenAiModelSummary[] {
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
  return models.flatMap((model) => {
    const id = readModelId(model.id);
    if (!id) return [];
    return [
      {
        id,
        object: "model" as const,
        created: readCreatedSeconds(model.created_at),
        owned_by: "anthropic"
      }
    ];
  });
}

function geminiModelsToOpenAi(payload: unknown): OpenAiModelSummary[] {
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models.filter(isRecord) : [];
  return models.flatMap((model) => {
    const id = readGeminiModelId(model.name);
    if (!id || !supportsGeminiGeneration(model)) return [];
    return [
      {
        id,
        object: "model" as const,
        created: 0,
        owned_by: "google"
      }
    ];
  });
}

function readModelId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readGeminiModelId(value: unknown): string | undefined {
  const id = readModelId(value);
  return id?.startsWith("models/") ? id.slice("models/".length) : id;
}

function geminiModelPath(model: string): string {
  const name = model.startsWith("models/") ? model : `models/${model}`;
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function supportsGeminiGeneration(model: Record<string, unknown>): boolean {
  if (!Array.isArray(model.supportedGenerationMethods)) {
    return true;
  }
  return model.supportedGenerationMethods.some(
    (method) => method === "generateContent" || method === "streamGenerateContent"
  );
}

function normalizeEmbeddingInputs(input: unknown): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return [""];
  }
  if (input.every((item) => typeof item === "string")) {
    return input as string[];
  }
  if (input.every((item) => typeof item === "number")) {
    return [(input as number[]).join(" ")];
  }
  if (input.every((item) => Array.isArray(item) && item.every((token) => typeof token === "number"))) {
    return (input as number[][]).map((tokens) => tokens.join(" "));
  }
  return input.map((item) => (typeof item === "string" ? item : ""));
}

function readGeminiEmbeddingValues(embedding: unknown): number[] {
  const source = isRecord(embedding) && isRecord(embedding.embedding) ? embedding.embedding : embedding;
  const values = isRecord(source) && Array.isArray(source.values) ? source.values : [];
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function readCreatedSeconds(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

interface StreamUsage {
  promptTokens?: number;
  completionTokens?: number;
}

interface StreamingToolCall {
  ordinal: number;
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Shared plumbing for the two upstream stream translators. Both need the same
 * lifecycle: announce the response, forward text and tool-call fragments as
 * they arrive, then close with a real finish reason and usage block.
 */
class StreamTranslation {
  private readonly toolCalls = new Map<number, StreamingToolCall>();
  private nextOrdinal = 0;
  private text = "";
  finishReason: string | null = null;
  usage: StreamUsage = {};

  constructor(
    private readonly writer: SseWriter,
    private readonly endpoint: TextEndpoint,
    private readonly id: string,
    private readonly model: string | undefined,
    private readonly includeUsage = false
  ) {}

  /**
   * Forwards upstream keep-alives as SSE comments. Without this, an upstream
   * that is thinking but only sending pings looks completely idle to the
   * relay's stall detector and gets killed as a hang.
   */
  keepAlive(): void {
    this.writer.comment("keep-alive");
  }

  begin(): void {
    if (this.endpoint === "responses") {
      this.writer.responseCreated(this.id, this.model);
    } else if (this.endpoint === "chat") {
      this.writer.chatChunk(this.id, this.model, { role: "assistant" });
    }
  }

  pushText(text: string): void {
    if (!text) {
      return;
    }
    this.text += text;
    this.writer.textDelta(this.endpoint, this.id, this.model, text);
  }

  /** Opens a tool call keyed by the upstream's block index. */
  openToolCall(blockIndex: number, callId: string, name: string): void {
    if (this.toolCalls.has(blockIndex)) {
      return;
    }
    const call: StreamingToolCall = { ordinal: this.nextOrdinal, callId, name, arguments: "" };
    this.nextOrdinal += 1;
    this.toolCalls.set(blockIndex, call);
    this.writer.toolCallStart(this.endpoint, this.id, this.model, call);
  }

  appendToolArguments(blockIndex: number, fragment: string): void {
    const call = this.toolCalls.get(blockIndex);
    if (!call || !fragment) {
      return;
    }
    call.arguments += fragment;
    this.writer.toolCallArguments(this.endpoint, this.id, this.model, call, fragment);
  }

  /** For upstreams that deliver a whole tool call in one piece. */
  emitCompleteToolCall(name: string, args: unknown): void {
    const blockIndex = -1 - this.nextOrdinal;
    this.openToolCall(blockIndex, `call_${randomId()}`, name);
    this.appendToolArguments(blockIndex, JSON.stringify(args ?? {}));
  }

  finish(): void {
    const calls = [...this.toolCalls.values()].sort((left, right) => left.ordinal - right.ordinal);
    const finishReason = this.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop");
    this.writer.completed(
      this.endpoint,
      this.id,
      this.model,
      { finishReason, text: this.text, toolCalls: calls, usage: this.usage },
      this.includeUsage
    );
    this.writer.done(this.endpoint);
  }
}

/**
 * Drives a translation over an upstream SSE body, guaranteeing the upstream
 * reader is released and the controller closed exactly once no matter how the
 * stream ends.
 */
function buildTranslatedStream(
  upstream: Response,
  body: ChatRequest,
  endpoint: TextEndpoint,
  idPrefix: string,
  handleFrame: (payload: Record<string, unknown>, translation: StreamTranslation) => void
): Response {
  const id = `${idPrefix}${randomId()}`;
  let cancelUpstream: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new SseWriter(controller);
      const parser = new SseParser();
      const reader = upstream.body?.getReader();
      if (!reader) {
        writer.done(endpoint);
        closeQuietly(controller);
        return;
      }

      cancelUpstream = () => {
        void reader.cancel().catch(() => undefined);
      };

      const translation = new StreamTranslation(
        writer,
        endpoint,
        id,
        body.model,
        body.stream_options?.include_usage === true
      );
      const consume = (data: string) => {
        if (!data || data === "[DONE]") {
          return;
        }
        const payload = safeJson(data);
        if (isRecord(payload)) {
          handleFrame(payload, translation);
        }
      };

      try {
        translation.begin();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.feed(value)) {
            consume(event.data);
          }
        }
        // A final frame not terminated by a blank line would otherwise be lost.
        for (const event of parser.end()) {
          consume(event.data);
        }

        translation.finish();
      } catch (error) {
        // The controller may already be closed if the consumer went away;
        // writing then throws and would mask the original failure.
        try {
          writer.error(endpoint, error instanceof Error ? error.message : String(error));
        } catch {
          // nothing further to report
        }
        void reader.cancel().catch(() => undefined);
      } finally {
        closeQuietly(controller);
      }
    },
    cancel() {
      // The downstream client walked away: release the upstream connection
      // instead of letting the provider stream into a dead consumer.
      cancelUpstream?.();
    }
  });

  return sseResponse(stream);
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // already closed or errored
  }
}

function transformAnthropicStream(upstream: Response, body: ChatRequest, endpoint: TextEndpoint): Response {
  const prefix = endpoint === "chat" ? "chatcmpl-" : endpoint === "completions" ? "cmpl-" : "resp_";
  return buildTranslatedStream(upstream, body, endpoint, prefix, (payload, translation) => {
    const blockIndex = readNumber(payload.index) ?? 0;

    switch (payload.type) {
      case "message_start": {
        const message = isRecord(payload.message) ? payload.message : undefined;
        const usage = message && isRecord(message.usage) ? message.usage : undefined;
        if (usage) {
          translation.usage.promptTokens = readNumber(usage.input_tokens);
        }
        return;
      }
      case "content_block_start": {
        const block = isRecord(payload.content_block) ? payload.content_block : undefined;
        if (!block) {
          return;
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          translation.openToolCall(
            blockIndex,
            typeof block.id === "string" ? block.id : `call_${randomId()}`,
            block.name
          );
          return;
        }
        if (typeof block.text === "string") {
          translation.pushText(block.text);
        }
        return;
      }
      case "content_block_delta": {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (!delta) {
          return;
        }
        if (typeof delta.text === "string") {
          translation.pushText(delta.text);
          return;
        }
        // Tool arguments stream in as JSON fragments.
        if (typeof delta.partial_json === "string") {
          translation.appendToolArguments(blockIndex, delta.partial_json);
        }
        return;
      }
      case "message_delta": {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta && typeof delta.stop_reason === "string") {
          translation.finishReason = mapAnthropicFinish(delta.stop_reason);
        }
        const usage = isRecord(payload.usage) ? payload.usage : undefined;
        if (usage) {
          translation.usage.completionTokens = readNumber(usage.output_tokens) ?? translation.usage.completionTokens;
        }
        return;
      }
      case "ping":
        // Anthropic's keep-alive during long thinking. Translate it rather than
        // swallowing it, or the stream looks stalled to the idle detector.
        translation.keepAlive();
        return;
      default:
        return;
    }
  });
}

function transformGeminiStream(upstream: Response, body: ChatRequest, endpoint: TextEndpoint): Response {
  const prefix = endpoint === "chat" ? "chatcmpl-" : endpoint === "completions" ? "cmpl-" : "resp_";
  return buildTranslatedStream(upstream, body, endpoint, prefix, (payload, translation) => {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.filter(isRecord) : [];
    for (const candidate of candidates) {
      const content = isRecord(candidate.content) ? candidate.content : undefined;
      const parts = content && Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
      for (const part of parts) {
        if (typeof part.text === "string") {
          translation.pushText(part.text);
        }
        // Gemini never splits a function call across chunks.
        if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
          translation.emitCompleteToolCall(part.functionCall.name, part.functionCall.args);
        }
      }
      if (typeof candidate.finishReason === "string") {
        translation.finishReason = mapGeminiFinish(candidate.finishReason);
      }
    }

    const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
    if (usage) {
      translation.usage.promptTokens = readNumber(usage.promptTokenCount) ?? translation.usage.promptTokens;
      translation.usage.completionTokens = readNumber(usage.candidatesTokenCount) ?? translation.usage.completionTokens;
    }
  });
}

interface StreamCompletion {
  finishReason: string | null;
  text: string;
  toolCalls: StreamingToolCall[];
  usage: StreamUsage;
}

class SseWriter {
  private readonly encoder = new TextEncoder();
  private readonly responseItemId = `msg_${randomId()}`;
  private sequenceNumber = 0;
  private responseTextStarted = false;
  /**
   * Responses output indices must be contiguous and must match the position of
   * the item in the final `output` array. They are therefore assigned in
   * emission order rather than derived from the tool-call ordinal: a
   * tool-call-only turn (the common agent case) has no message at index 0.
   */
  private nextOutputIndex = 0;
  private textOutputIndex?: number;
  private readonly toolOutputIndex = new Map<string, number>();

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  private outputIndexForTool(callId: string): number {
    const existing = this.toolOutputIndex.get(callId);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.toolOutputIndex.set(callId, index);
    return index;
  }

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
    const response = {
      id,
      object: "response",
      created_at: nowSeconds(),
      status: "in_progress",
      model,
      output: []
    };
    this.writeEvent("response.created", { type: "response.created", response });
    this.writeEvent("response.in_progress", { type: "response.in_progress", response });
  }

  textDelta(endpoint: TextEndpoint, id: string, model: string | undefined, text: string): void {
    if (endpoint === "chat") {
      this.chatChunk(id, model, { content: text });
      return;
    }
    if (endpoint === "completions") {
      this.completionChunk(id, model, text);
      return;
    }

    // Responses requires the item/content-part scaffolding before deltas.
    if (!this.responseTextStarted) {
      this.responseTextStarted = true;
      this.textOutputIndex = this.nextOutputIndex;
      this.nextOutputIndex += 1;
      this.writeEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.textOutputIndex,
        item: { id: this.responseItemId, type: "message", status: "in_progress", role: "assistant", content: [] }
      });
      this.writeEvent("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.responseItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }

    this.writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.responseItemId,
      output_index: this.textOutputIndex ?? 0,
      content_index: 0,
      delta: text
    });
  }

  toolCallStart(endpoint: TextEndpoint, id: string, model: string | undefined, call: StreamingToolCall): void {
    if (endpoint === "chat") {
      this.chatChunk(id, model, {
        tool_calls: [
          {
            index: call.ordinal,
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: "" }
          }
        ]
      });
      return;
    }
    if (endpoint === "responses") {
      this.writeEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.outputIndexForTool(call.callId),
        item: {
          id: `fc_${call.callId}`,
          type: "function_call",
          status: "in_progress",
          call_id: call.callId,
          name: call.name,
          arguments: ""
        }
      });
    }
    // Legacy /v1/completions has no representation for tool calls.
  }

  toolCallArguments(
    endpoint: TextEndpoint,
    id: string,
    model: string | undefined,
    call: StreamingToolCall,
    fragment: string
  ): void {
    if (endpoint === "chat") {
      this.chatChunk(id, model, {
        tool_calls: [{ index: call.ordinal, function: { arguments: fragment } }]
      });
      return;
    }
    if (endpoint === "responses") {
      this.writeEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${call.callId}`,
        output_index: this.outputIndexForTool(call.callId),
        delta: fragment
      });
    }
  }

  completed(
    endpoint: TextEndpoint,
    id: string,
    model: string | undefined,
    result: StreamCompletion,
    includeUsage = false
  ): void {
    const promptTokens = result.usage.promptTokens ?? 0;
    const completionTokens = result.usage.completionTokens ?? 0;

    if (endpoint === "chat") {
      this.chatChunk(id, model, {}, result.finishReason);
      // Only when the client opted in: real OpenAI omits this chunk otherwise,
      // and plenty of client code reads choices[0] without guarding.
      if (includeUsage) {
        this.writeData({
          id,
          object: "chat.completion.chunk",
          created: nowSeconds(),
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          }
        });
      }
      return;
    }
    if (endpoint === "completions") {
      this.completionChunk(id, model, "", result.finishReason);
      return;
    }

    // Emit in output_index order so the announced indices match the positions
    // of the items in the `output` array below.
    const items: Array<{ index: number; emit: () => Record<string, unknown> }> = [];

    if (this.responseTextStarted) {
      const textIndex = this.textOutputIndex ?? 0;
      items.push({
        index: textIndex,
        emit: () => {
          this.writeEvent("response.output_text.done", {
            type: "response.output_text.done",
            item_id: this.responseItemId,
            output_index: textIndex,
            content_index: 0,
            text: result.text
          });
          this.writeEvent("response.content_part.done", {
            type: "response.content_part.done",
            item_id: this.responseItemId,
            output_index: textIndex,
            content_index: 0,
            part: { type: "output_text", text: result.text, annotations: [] }
          });
          const messageItem = {
            id: this.responseItemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: result.text, annotations: [] }]
          };
          this.writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: textIndex,
            item: messageItem
          });
          return messageItem;
        }
      });
    }

    for (const call of result.toolCalls) {
      const callIndex = this.outputIndexForTool(call.callId);
      items.push({
        index: callIndex,
        emit: () => {
          this.writeEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: `fc_${call.callId}`,
            output_index: callIndex,
            arguments: call.arguments
          });
          const callItem = {
            id: `fc_${call.callId}`,
            type: "function_call",
            status: "completed",
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments
          };
          this.writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: callIndex,
            item: callItem
          });
          return callItem;
        }
      });
    }

    items.sort((left, right) => left.index - right.index);
    const output = items.map((item) => item.emit());

    this.writeEvent("response.completed", {
      type: "response.completed",
      response: {
        id,
        object: "response",
        created_at: nowSeconds(),
        status: "completed",
        model,
        output_text: result.text,
        output,
        usage: toResponsesUsage(promptTokens, completionTokens)
      }
    });
  }

  done(endpoint: TextEndpoint): void {
    if (endpoint === "chat" || endpoint === "completions") {
      this.writeRaw("data: [DONE]\n\n");
    }
  }

  /** Keeps intermediaries from timing out a stream that is merely slow. */
  comment(text: string): void {
    this.writeRaw(`: ${text}\n\n`);
  }

  error(endpoint: TextEndpoint, message: string): void {
    if (endpoint === "responses") {
      // The Responses error event is flat; the Chat shape would lose the text.
      this.writeEvent("error", { type: "error", code: null, message, param: null });
      return;
    }
    this.writeEvent("error", { type: "error", error: { message } });
  }

  private writeData(payload: Record<string, unknown>): void {
    this.writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private completionChunk(
    id: string,
    model: string | undefined,
    text: string,
    finishReason: string | null = null
  ): void {
    this.writeData({
      id,
      object: "text_completion",
      created: nowSeconds(),
      model,
      choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason }]
    });
  }

  private writeEvent(event: string, payload: Record<string, unknown>): void {
    this.sequenceNumber += 1;
    const enriched = { ...payload, sequence_number: this.sequenceNumber };
    this.writeRaw(`event: ${event}\ndata: ${JSON.stringify(enriched)}\n\n`);
  }

  private writeRaw(value: string): void {
    this.controller.enqueue(this.encoder.encode(value));
  }
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function unsupportedResponse(protocol: string, path: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: "unsupported_endpoint",
        message: `${protocol} does not support an OpenAI-compatible adapter for ${path}`
      }
    }),
    {
      status: 501,
      headers: { "content-type": "application/json; charset=utf-8" }
    }
  );
}

function resolveApiKey(config: UpstreamConfig, headers: Record<string, string | string[] | undefined>): string | undefined {
  return clientApiKey(headers) ?? config.api_key;
}

function bearerToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers.authorization ?? headers.Authorization;
  const authorization = Array.isArray(value) ? value[0] : value;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return cleanApiKey(match?.[1]);
}

function clientApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  return bearerToken(headers) ?? firstHeaderValue(headers, "x-api-key") ?? firstHeaderValue(headers, "x-goog-api-key") ?? firstHeaderValue(headers, "api-key");
}

function firstHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = match?.[1];
  return cleanApiKey(Array.isArray(value) ? value[0] : value);
}

function cleanApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function geminiNativePath(path: string): string {
  if (path.startsWith("/upload/")) {
    return path;
  }
  if (path.startsWith("/v1/")) {
    return path.slice("/v1/".length);
  }
  if (path === "/v1") {
    return "";
  }
  if (path.startsWith("/v1beta/")) {
    return path.slice("/v1beta/".length);
  }
  if (path.startsWith("/")) {
    return path.slice(1);
  }
  return path;
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
