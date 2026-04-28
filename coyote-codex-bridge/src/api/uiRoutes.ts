import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { configSchema, type AppConfig, type Channel, type UpstreamProtocol } from "../config/schema.js";
import type { DglabController } from "../dglab/controller.js";
import type { EventBus } from "../events/bus.js";
import type { PolicySettingsPatch, ShockPolicy } from "../shock/policy.js";
import type { SafetyGate, SafetySettingsPatch } from "../shock/safety.js";

interface UiRouteContext {
  config: AppConfig;
  bus: EventBus;
  safety: SafetyGate;
  policy: ShockPolicy;
  dglab?: DglabController;
}

export function registerUiRoutes(app: FastifyInstance, context: UiRouteContext): void {
  const uiRoot = join(process.cwd(), "src", "ui");

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFile(join(uiRoot, "index.html"), "utf8");
  });

  app.get("/ui", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFile(join(uiRoot, "index.html"), "utf8");
  });

  app.get("/ui/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readFile(join(uiRoot, "index.html"), "utf8");
  });

  app.get("/ui/app.js", async (_request, reply) => {
    reply.type("application/javascript; charset=utf-8");
    return readFile(join(uiRoot, "app.js"), "utf8");
  });

  app.get("/ui/styles.css", async (_request, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFile(join(uiRoot, "styles.css"), "utf8");
  });

  app.get("/ui/state", async () => buildUiState(context));

  app.post<{ Body: Buffer }>("/ui/start", async () => {
    context.safety.arm();
    context.bus.emit({ type: "safety.armed", timestamp: Date.now() });
    return buildUiState(context);
  });

  app.post("/ui/stop", async () => {
    context.safety.disarm();
    context.bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    if (context.dglab) {
      await context.dglab.disconnect();
    }
    return buildUiState(context);
  });

  app.post("/ui/settings", async (request) => {
    const body = parseJsonBody(request.body);
    const dryRun = readBoolean(body, "dryRun");
    if (dryRun !== undefined) {
      context.safety.setDryRun(dryRun);
    }

    const safety = readObject(body, "safety");
    if (safety) {
      const safetyPatch = readSafetyPatch(safety);
      context.safety.updateSettings(safetyPatch);
    }

    const policy = readObject(body, "policy");
    if (policy) {
      const policyPatch = readPolicyPatch(policy);
      context.policy.updateSettings(policyPatch);
    }

    return buildUiState(context);
  });

  app.post("/ui/upstream", async (request) => {
    const body = parseJsonBody(request.body);
    const upstream = readObject(body, "upstream") ?? body;
    const nextConfig = configSchema.parse({
      ...context.config,
      upstream: {
        ...context.config.upstream,
        name: readString(upstream, "name") ?? context.config.upstream.name,
        protocol: readProtocol(upstream, "protocol") ?? context.config.upstream.protocol,
        base_url: readString(upstream, "baseUrl") ?? readString(upstream, "base_url") ?? context.config.upstream.base_url,
        api_key_env: readString(upstream, "apiKeyEnv") ?? readString(upstream, "api_key_env") ?? context.config.upstream.api_key_env,
        api_key:
          upstream.apiKey === undefined && upstream.api_key === undefined
            ? context.config.upstream.api_key
            : readOptionalString(upstream, "apiKey") ?? readOptionalString(upstream, "api_key"),
        anthropic_version:
          readString(upstream, "anthropicVersion") ??
          readString(upstream, "anthropic_version") ??
          context.config.upstream.anthropic_version,
        timeout_ms: readNumber(upstream, "timeoutMs") ?? readNumber(upstream, "timeout_ms") ?? context.config.upstream.timeout_ms
      }
    });

    Object.assign(context.config.upstream, nextConfig.upstream);
    return buildUiState(context);
  });

  app.get("/ui/qr.svg", async (_request, reply) => {
    if (!context.dglab) {
      reply.code(404);
      return { ok: false, error: "dglab_disabled" };
    }
    await context.dglab.connect();
    await context.dglab.waitForClientId();
    const qrLink = context.dglab.getStatus().qrLink;
    if (!qrLink) {
      reply.code(503);
      return { ok: false, error: "qr_not_ready" };
    }
    const svg = await QRCode.toString(qrLink, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: {
        dark: "#172033",
        light: "#ffffff"
      }
    });
    reply.type("image/svg+xml; charset=utf-8");
    return svg;
  });
}

function buildUiState(context: UiRouteContext) {
  return {
    ok: true,
    service: "coyote-codex-bridge",
    upstream: {
      name: context.config.upstream.name,
      protocol: context.config.upstream.protocol,
      baseUrl: context.config.upstream.base_url,
      apiKeyEnv: context.config.upstream.api_key_env,
      hasApiKey: Boolean(context.config.upstream.api_key || process.env[context.config.upstream.api_key_env]),
      anthropicVersion: context.config.upstream.anthropic_version,
      timeoutMs: context.config.upstream.timeout_ms
    },
    safety: context.safety.getStatus(),
    policy: toClientPolicy(context.policy.getSettings()),
    dglab: context.dglab?.getStatus() ?? { enabled: false, connected: false, bound: false },
    events: context.bus.getRecent().slice(-20)
  };
}

function toClientPolicy(policy: AppConfig["policy"]) {
  return {
    requestStarted: {
      channel: policy.request_started.channel,
      intensity: policy.request_started.intensity,
      durationMs: policy.request_started.duration_ms
    },
    responseStarted: {
      channel: policy.response_started.channel,
      intensity: policy.response_started.intensity,
      durationMs: policy.response_started.duration_ms
    },
    responseChunk: {
      channel: policy.response_chunk.channel,
      minIntensity: policy.response_chunk.min_intensity,
      maxIntensity: policy.response_chunk.max_intensity,
      durationMs: policy.response_chunk.duration_ms,
      rateWindowMs: policy.response_chunk.rate_window_ms
    },
    responseDone: {
      channel: policy.response_done.channel,
      intensity: policy.response_done.intensity,
      durationMs: policy.response_done.duration_ms
    }
  };
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (!body) {
    return {};
  }
  if (Buffer.isBuffer(body)) {
    if (body.byteLength === 0) {
      return {};
    }
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(body) ? body : {};
}

function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  return typeof source[key] === "boolean" ? source[key] : undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  return typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] : undefined;
}

function readProtocol(source: Record<string, unknown>, key: string): UpstreamProtocol | undefined {
  const value = source[key];
  return value === "openai" || value === "anthropic" || value === "gemini" ? value : undefined;
}

function readChannel(source: Record<string, unknown>, key: string): Channel | undefined {
  return source[key] === "A" || source[key] === "B" ? source[key] : undefined;
}

function readSafetyPatch(safety: Record<string, unknown>): SafetySettingsPatch {
  const channelLimits = readObject(safety, "channelLimits");
  return {
    channelLimits: channelLimits
      ? {
          A: readNumber(channelLimits, "A"),
          B: readNumber(channelLimits, "B")
        }
      : undefined,
    minEventIntervalMs: readNumber(safety, "minEventIntervalMs"),
    maxContinuousOutputMs: readNumber(safety, "maxContinuousOutputMs"),
    maxEventsPerMinute: readNumber(safety, "maxEventsPerMinute")
  };
}

function readPolicyPatch(policy: Record<string, unknown>): PolicySettingsPatch {
  return {
    requestStarted: readPulsePatch(policy, "requestStarted"),
    responseStarted: readPulsePatch(policy, "responseStarted"),
    responseDone: readPulsePatch(policy, "responseDone"),
    responseChunk: readChunkPatch(policy)
  };
}

function readPulsePatch(policy: Record<string, unknown>, key: string): PolicySettingsPatch["requestStarted"] {
  const value = readObject(policy, key);
  if (!value) {
    return undefined;
  }
  return {
    channel: readChannel(value, "channel"),
    intensity: readNumber(value, "intensity"),
    durationMs: readNumber(value, "durationMs")
  };
}

function readChunkPatch(policy: Record<string, unknown>): PolicySettingsPatch["responseChunk"] {
  const value = readObject(policy, "responseChunk");
  if (!value) {
    return undefined;
  }
  return {
    channel: readChannel(value, "channel"),
    minIntensity: readNumber(value, "minIntensity"),
    maxIntensity: readNumber(value, "maxIntensity"),
    durationMs: readNumber(value, "durationMs"),
    rateWindowMs: readNumber(value, "rateWindowMs")
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
