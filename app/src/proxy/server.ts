import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "../config/schema.js";
import { registerDglabRoutes } from "../api/dglabRoutes.js";
import { registerShockRoutes } from "../api/shockRoutes.js";
import { registerUiRoutes } from "../api/uiRoutes.js";
import type { DglabController } from "../dglab/controller.js";
import { EventBus } from "../events/bus.js";
import type { ResponseChunkEvent } from "../events/types.js";
import type { ShockPlanStore } from "../shock/planStore.js";
import { shortId } from "../util/ids.js";
import { registerControlRoutes } from "../api/controlRoutes.js";
import type { ShockPolicy } from "../shock/policy.js";
import type { SafetyGate } from "../shock/safety.js";
import { SseParser } from "./sse.js";
import { UpstreamClient } from "./upstream.js";

interface ProxyContext {
  config: AppConfig;
  bus: EventBus;
  safety: SafetyGate;
  policy: ShockPolicy;
  dglab?: DglabController;
  shockPlans?: ShockPlanStore;
}

export function buildServer(context: ProxyContext): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  const upstream = new UpstreamClient(context.config.upstream);

  app.addHook("onRequest", (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedBrowserOrigin(origin)) {
      reply.code(403).send({ ok: false, error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "origin");
    }
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization,x-api-key,x-goog-api-key,anthropic-version");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
    done();
  });

  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({
    ok: true,
    service: "coyotecoder",
    time: new Date().toISOString()
  }));

  app.get("/status", async () => ({
    ok: true,
    upstream: {
      name: context.config.upstream.name,
      protocol: context.config.upstream.protocol,
      base_url: context.config.upstream.base_url
    },
    safety: context.safety.getStatus()
  }));

  app.get("/events/recent", async () => ({
    events: context.bus.getRecent()
  }));

  registerControlRoutes(app, context.bus, context.safety);
  registerDglabRoutes(app, context.dglab);
  registerShockRoutes(app, context.shockPlans);
  registerUiRoutes(app, context);

  app.all("/v1/*", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });
  app.all("/v1beta/*", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });
  app.all("/models/*", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });
  app.all("/files", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });
  app.all("/files/*", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });
  app.all("/upload/*", async (request, reply) => {
    await handleProxyRequest(request, reply, context, upstream);
  });

  return app;
}

async function handleProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ProxyContext,
  upstream: UpstreamClient
): Promise<void> {
  const requestId = shortId();
  const startedAt = Date.now();
  const path = request.url.split("?")[0];
  const query = request.url.includes("?") ? `?${request.url.split("?").slice(1).join("?")}` : "";
  const body = serializeRequestBody(request.body);
  const bodyInfo = inspectRequestBody(body);
  const knownEventEndpoint = path === "/v1/chat/completions" || path === "/v1/responses" || path === "/v1/completions";

  if (knownEventEndpoint) {
    context.bus.emit({
      type: "request.started",
      requestId,
      timestamp: startedAt,
      model: bodyInfo.model
    });
    context.bus.emit({
      type: "request.body_seen",
      requestId,
      timestamp: Date.now(),
      model: bodyInfo.model,
      bytes: body?.byteLength ?? 0,
      stream: bodyInfo.stream,
      endpoint: path
    });
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort();
  const abortOnReplyClose = () => {
    if (!reply.raw.writableEnded) {
      abort();
    }
  };
  request.raw.on("aborted", abort);
  reply.raw.on("close", abortOnReplyClose);

  try {
    const upstreamResponse = await upstream.request({
      method: request.method,
      path,
      query,
      headers: request.headers,
      body,
      signal: abortController.signal
    });

    if (knownEventEndpoint) {
      context.bus.emit({
        type: "response.started",
        requestId,
        timestamp: Date.now(),
        model: bodyInfo.model
      });
    }

    copyResponseHeaders(upstreamResponse, reply);
    reply.code(upstreamResponse.status);

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream");
    if (isSse && upstreamResponse.body) {
      await relaySse(upstreamResponse, reply, context, requestId, bodyInfo.model, startedAt, knownEventEndpoint, abortController.signal);
      return;
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();
    const responseBody = Buffer.from(arrayBuffer);
    if (knownEventEndpoint) {
      emitFinalResponseEvents(context, {
        requestId,
        model: bodyInfo.model,
        startedAt,
        statusCode: upstreamResponse.status,
        bodyText: responseBody.toString("utf8"),
        bytes: responseBody.byteLength
      });
    }
    reply.send(responseBody);
  } catch (error) {
    const message = sanitizeDiagnosticMessage(error instanceof Error ? error.message : String(error));
    if (knownEventEndpoint) {
      context.bus.emit({
        type: abortController.signal.aborted ? "response.aborted" : "response.error",
        requestId,
        timestamp: Date.now(),
        model: bodyInfo.model,
        message
      });
    }
    if (!reply.sent) {
      reply.code(502).send({ error: "upstream_error", message });
    }
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abortOnReplyClose);
  }
}

async function relaySse(
  upstreamResponse: Response,
  reply: FastifyReply,
  context: ProxyContext,
  requestId: string,
  model: string | undefined,
  startedAt: number,
  emitEvents: boolean,
  signal: AbortSignal
): Promise<void> {
  const parser = new SseParser();
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    reply.raw.end();
    return;
  }

  let lastChunkAt = Date.now();
  let cumulativeChars = 0;
  let outputChars = 0;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let finishReason: string | undefined;
  let toolCallEmitted = false;
  let abortEmitted = false;

  const emitAborted = (message = "downstream client disconnected") => {
    if (!emitEvents || abortEmitted) {
      return;
    }
    abortEmitted = true;
    context.bus.emit({
      type: "response.aborted",
      requestId,
      timestamp: Date.now(),
      model,
      message
    });
  };

  reply.raw.flushHeaders?.();

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        emitAborted();
        safeEnd(reply);
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        emitAborted();
        safeEnd(reply);
        return;
      }

      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(Buffer.from(value));
      }
      if (!emitEvents) continue;

      const now = Date.now();
      const deltaMs = Math.max(1, now - lastChunkAt);
      lastChunkAt = now;
      for (const event of parser.feed(value)) {
        if (!event.data || event.data === "[DONE]") {
          continue;
        }
        const metadata = inspectResponseMetadata(event.data);
        outputChars += metadata.outputChars;
        outputTokens = metadata.outputTokens ?? outputTokens;
        totalTokens = metadata.totalTokens ?? totalTokens;
        finishReason = metadata.finishReason ?? finishReason;
        if (!toolCallEmitted && metadata.toolCallCount > 0) {
          toolCallEmitted = true;
          context.bus.emit({
            type: "response.tool_call",
            requestId,
            timestamp: now,
            model,
            toolCallCount: metadata.toolCallCount,
            toolNames: metadata.toolNames.length > 0 ? metadata.toolNames : undefined
          });
        }
        const chars = event.data.length;
        cumulativeChars += chars;
        const chunkEvent: ResponseChunkEvent = {
          type: "response.chunk",
          requestId,
          timestamp: now,
          model,
          bytes: Buffer.byteLength(event.data, "utf8"),
          chars,
          deltaMs,
          cumulativeChars,
          streamRateCharsPerSec: chars / (deltaMs / 1000)
        };
        context.bus.emit(chunkEvent);
      }
    }

    if (signal.aborted) {
      emitAborted();
      safeEnd(reply);
      return;
    }

    for (const event of parser.end()) {
      if (emitEvents && event.data && event.data !== "[DONE]") {
        const metadata = inspectResponseMetadata(event.data);
        outputChars += metadata.outputChars;
        outputTokens = metadata.outputTokens ?? outputTokens;
        totalTokens = metadata.totalTokens ?? totalTokens;
        finishReason = metadata.finishReason ?? finishReason;
        if (!toolCallEmitted && metadata.toolCallCount > 0) {
          toolCallEmitted = true;
          context.bus.emit({
            type: "response.tool_call",
            requestId,
            timestamp: Date.now(),
            model,
            toolCallCount: metadata.toolCallCount,
            toolNames: metadata.toolNames.length > 0 ? metadata.toolNames : undefined
          });
        }
        const chars = event.data.length;
        cumulativeChars += chars;
        context.bus.emit({
          type: "response.chunk",
          requestId,
          timestamp: Date.now(),
          model,
          bytes: Buffer.byteLength(event.data, "utf8"),
          chars,
          deltaMs: Math.max(1, Date.now() - lastChunkAt),
          cumulativeChars,
          streamRateCharsPerSec: chars / (Math.max(1, Date.now() - lastChunkAt) / 1000)
        });
      }
    }

    if (emitEvents) {
      const inferredOutputTokens = outputTokens ?? estimateTokens(outputChars);
      if (upstreamResponse.status >= 400) {
        context.bus.emit({
          type: "response.error_status",
          requestId,
          timestamp: Date.now(),
          model,
          statusCode: upstreamResponse.status,
          chars: cumulativeChars,
          durationMs: Date.now() - startedAt
        });
      } else {
        context.bus.emit({
          type: "response.done",
          requestId,
          timestamp: Date.now(),
          model,
          statusCode: upstreamResponse.status,
          chars: cumulativeChars,
          durationMs: Date.now() - startedAt,
          outputTokens: inferredOutputTokens,
          totalTokens,
          estimatedTokens: outputTokens === undefined,
          finishReason
        });
      }
    }
    safeEnd(reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted || isAbortError(error)) {
      emitAborted(message);
      safeEnd(reply);
      return;
    }
    if (emitEvents) {
      context.bus.emit({
        type: "response.error",
        requestId,
        timestamp: Date.now(),
        model,
        message
      });
    }
    safeEnd(reply);
  }
}

function safeEnd(reply: FastifyReply): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.end();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

function inspectRequestBody(body: Buffer | undefined): { model?: string; stream: boolean } {
  if (!body || body.byteLength === 0) {
    return { stream: false };
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown; stream?: unknown };
    return {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      stream: parsed.stream === true
    };
  } catch {
    return { stream: false };
  }
}

function serializeRequestBody(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return Buffer.from(JSON.stringify(body), "utf8");
}

interface FinalResponseInput {
  requestId: string;
  model: string | undefined;
  startedAt: number;
  statusCode: number;
  bodyText: string;
  bytes: number;
}

interface ResponseMetadata {
  outputChars: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  toolCallCount: number;
  toolNames: string[];
  errorMessage?: string;
}

function emitFinalResponseEvents(context: ProxyContext, input: FinalResponseInput): void {
  const metadata = inspectResponseMetadata(input.bodyText);
  if (metadata.toolCallCount > 0) {
    context.bus.emit({
      type: "response.tool_call",
      requestId: input.requestId,
      timestamp: Date.now(),
      model: input.model,
      toolCallCount: metadata.toolCallCount,
      toolNames: metadata.toolNames.length > 0 ? metadata.toolNames : undefined
    });
  }

  if (input.statusCode >= 400) {
    context.bus.emit({
      type: "response.error_status",
      requestId: input.requestId,
      timestamp: Date.now(),
      model: input.model,
      statusCode: input.statusCode,
      bytes: input.bytes,
      chars: input.bodyText.length,
      message: metadata.errorMessage,
      durationMs: Date.now() - input.startedAt
    });
    return;
  }

  const outputTokens = metadata.outputTokens ?? estimateTokens(metadata.outputChars);
  context.bus.emit({
    type: "response.done",
    requestId: input.requestId,
    timestamp: Date.now(),
    model: input.model,
    statusCode: input.statusCode,
    bytes: input.bytes,
    chars: input.bodyText.length,
    durationMs: Date.now() - input.startedAt,
    outputTokens,
    totalTokens: metadata.totalTokens,
    estimatedTokens: metadata.outputTokens === undefined,
    finishReason: metadata.finishReason
  });
}

function inspectResponseMetadata(text: string): ResponseMetadata {
  const payload = safeJson(text);
  if (!isRecord(payload)) {
    return { outputChars: 0, toolCallCount: 0, toolNames: [] };
  }

  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  const toolNames: string[] = [];
  return {
    outputChars: extractOutputTextChars(payload),
    outputTokens: usage ? readFirstNumber(usage, ["completion_tokens", "output_tokens", "completionTokens", "outputTokens"]) : undefined,
    totalTokens: usage ? readFirstNumber(usage, ["total_tokens", "totalTokens"]) : undefined,
    finishReason: readFinishReason(payload),
    toolCallCount: countToolCalls(payload, toolNames),
    toolNames: [...new Set(toolNames)],
    errorMessage: readErrorMessage(payload)
  };
}

function extractOutputTextChars(payload: Record<string, unknown>): number {
  let chars = 0;

  if (typeof payload.output_text === "string") {
    chars += payload.output_text.length;
  }
  if (typeof payload.delta === "string" && typeof payload.type === "string" && payload.type.includes("output_text")) {
    chars += payload.delta.length;
  }
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices.filter(isRecord)) {
      chars += readContentChars(choice.text);
      if (isRecord(choice.message)) {
        chars += readContentChars(choice.message.content);
      }
      if (isRecord(choice.delta)) {
        chars += readContentChars(choice.delta.content);
      }
    }
  }
  if (Array.isArray(payload.output)) {
    for (const item of payload.output.filter(isRecord)) {
      chars += readContentChars(item.content);
    }
  }
  if (Array.isArray(payload.content)) {
    chars += readContentChars(payload.content);
  }

  return chars;
}

function readContentChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (!Array.isArray(value)) {
    return 0;
  }
  let chars = 0;
  for (const item of value.filter(isRecord)) {
    if (typeof item.text === "string") {
      chars += item.text.length;
    }
    if (typeof item.output_text === "string") {
      chars += item.output_text.length;
    }
  }
  return chars;
}

function readFinishReason(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.finish_reason === "string") {
    return payload.finish_reason;
  }
  if (typeof payload.stop_reason === "string") {
    return payload.stop_reason;
  }
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices.filter(isRecord)) {
      if (typeof choice.finish_reason === "string") {
        return choice.finish_reason;
      }
    }
  }
  return undefined;
}

function countToolCalls(value: unknown, toolNames: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countToolCalls(item, toolNames), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }

  let count = 0;
  if (Array.isArray(value.tool_calls)) {
    count += value.tool_calls.length;
    for (const item of value.tool_calls.filter(isRecord)) {
      collectToolName(item, toolNames);
    }
  }
  if (isRecord(value.function_call)) {
    count += 1;
    collectToolName(value.function_call, toolNames);
  }
  if (value.type === "function_call" || value.type === "tool_use") {
    count += 1;
    collectToolName(value, toolNames);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "tool_calls" || key === "function_call") {
      continue;
    }
    count += countToolCalls(nested, toolNames);
  }
  return count;
}

function collectToolName(value: Record<string, unknown>, toolNames: string[]): void {
  if (typeof value.name === "string" && value.name.trim()) {
    toolNames.push(value.name.trim());
  }
  if (isRecord(value.function) && typeof value.function.name === "string" && value.function.name.trim()) {
    toolNames.push(value.function.name.trim());
  }
}

function readErrorMessage(payload: Record<string, unknown>): string | undefined {
  let message: string | undefined;
  if (typeof payload.error === "string") {
    message = payload.error;
  } else if (isRecord(payload.error) && typeof payload.error.message === "string") {
    message = payload.error.message;
  } else if (typeof payload.message === "string") {
    message = payload.message;
  }
  return message ? sanitizeDiagnosticMessage(message) : undefined;
}

function readFirstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function estimateTokens(chars: number): number | undefined {
  if (chars <= 0) {
    return undefined;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|x-api-key|x-goog-api-key)([\"'\s:=]+)[^\"'\s,}]+/gi, "$1$2[redacted]")
    .slice(0, 500);
}

function copyResponseHeaders(upstreamResponse: Response, reply: FastifyReply): void {
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "keep-alive" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-authorization" ||
      lower === "te" ||
      lower === "trailer" ||
      lower === "transfer-encoding" ||
      lower === "upgrade"
    ) {
      return;
    }
    reply.header(key, value);
  });
}
