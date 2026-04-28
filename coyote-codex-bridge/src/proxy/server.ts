import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "../config/schema.js";
import { registerDglabRoutes } from "../api/dglabRoutes.js";
import { registerUiRoutes } from "../api/uiRoutes.js";
import type { DglabController } from "../dglab/controller.js";
import { EventBus } from "../events/bus.js";
import type { ResponseChunkEvent } from "../events/types.js";
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
}

export function buildServer(context: ProxyContext): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  const upstream = new UpstreamClient(context.config.upstream);

  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/health", async () => ({
    ok: true,
    service: "coyote-codex-bridge",
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
  registerUiRoutes(app, context);

  app.all("/v1/*", async (request, reply) => {
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
  const knownEventEndpoint = path === "/v1/chat/completions" || path === "/v1/responses";

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
  request.raw.on("aborted", () => abortController.abort());

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
      await relaySse(upstreamResponse, reply, context, requestId, bodyInfo.model, startedAt, knownEventEndpoint);
      return;
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();
    const responseBody = Buffer.from(arrayBuffer);
    if (knownEventEndpoint) {
      context.bus.emit({
        type: "response.done",
        requestId,
        timestamp: Date.now(),
        model: bodyInfo.model,
        statusCode: upstreamResponse.status,
        bytes: responseBody.byteLength,
        chars: responseBody.toString("utf8").length,
        durationMs: Date.now() - startedAt
      });
    }
    reply.send(responseBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
  }
}

async function relaySse(
  upstreamResponse: Response,
  reply: FastifyReply,
  context: ProxyContext,
  requestId: string,
  model: string | undefined,
  startedAt: number,
  emitEvents: boolean
): Promise<void> {
  const parser = new SseParser();
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    reply.raw.end();
    return;
  }

  let lastChunkAt = Date.now();
  let cumulativeChars = 0;

  reply.raw.flushHeaders?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      reply.raw.write(Buffer.from(value));
      if (!emitEvents) continue;

      const now = Date.now();
      const deltaMs = Math.max(1, now - lastChunkAt);
      lastChunkAt = now;
      for (const event of parser.feed(value)) {
        if (!event.data || event.data === "[DONE]") {
          continue;
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

    for (const event of parser.end()) {
      if (emitEvents && event.data && event.data !== "[DONE]") {
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
      context.bus.emit({
        type: "response.done",
        requestId,
        timestamp: Date.now(),
        model,
        statusCode: upstreamResponse.status,
        chars: cumulativeChars,
        durationMs: Date.now() - startedAt
      });
    }
    reply.raw.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (emitEvents) {
      context.bus.emit({
        type: "response.error",
        requestId,
        timestamp: Date.now(),
        model,
        message
      });
    }
    reply.raw.end();
  }
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

function copyResponseHeaders(upstreamResponse: Response, reply: FastifyReply): void {
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
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
