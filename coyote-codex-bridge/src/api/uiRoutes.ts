import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import QRCode from "qrcode";
import { writeConfigPatch } from "../config/configFile.js";
import { configSchema, type AppConfig, type Channel, type UpstreamProtocol, type UpstreamProviderConfig } from "../config/schema.js";
import type { DglabController } from "../dglab/controller.js";
import { softPulseWave } from "../dglab/waves.js";
import type { EventBus } from "../events/bus.js";
import type { ShockPlanStore } from "../shock/planStore.js";
import type { PolicySettingsPatch, ShockPolicy } from "../shock/policy.js";
import type { SafetyGate, SafetySettingsPatch } from "../shock/safety.js";
import type { ShockPlan } from "../shock/types.js";

interface UiRouteContext {
  config: AppConfig;
  bus: EventBus;
  safety: SafetyGate;
  policy: ShockPolicy;
  dglab?: DglabController;
  shockPlans?: ShockPlanStore;
}

export function registerUiRoutes(app: FastifyInstance, context: UiRouteContext): void {
  const legacyUiRoot = join(process.cwd(), "src", "ui");
  const builtUiRoot = join(process.cwd(), "src-ui", "dist");

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  app.get("/ui", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  app.get("/ui/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  const serveBuiltAsset = async (assetPath: string, reply: FastifyReply) => {
    if (!assetPath || assetPath.includes("..")) {
      reply.code(400);
      return { ok: false, error: "invalid_asset_path" };
    }
    const file = join(builtUiRoot, "assets", assetPath);
    reply.type(contentTypeFor(file));
    return readFile(file);
  };

  app.get<{ Params: { "*": string } }>("/ui/assets/*", async (request, reply) => serveBuiltAsset(request.params["*"], reply));
  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => serveBuiltAsset(request.params["*"], reply));

  app.get("/ui/app.js", async (_request, reply) => {
    reply.type("application/javascript; charset=utf-8");
    return readFile(join(legacyUiRoot, "app.js"), "utf8");
  });

  app.get("/ui/styles.css", async (_request, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFile(join(legacyUiRoot, "styles.css"), "utf8");
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

  app.post("/ui/test-shock", async (request) => {
    const body = parseJsonBody(request.body);
    const result = await sendTestShock(context, {
      channel: readChannel(body, "channel") ?? "A",
      intensity: readNumber(body, "intensity") ?? 0.05,
      durationMs: readNumber(body, "durationMs") ?? 220
    });
    return {
      ...buildUiState(context),
      testShock: result
    };
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
    const action = readString(body, "action");
    const upstream = readObject(body, "upstream") ?? body;
    const providerId = readString(upstream, "id") ?? readString(body, "id");
    let providers = [...context.config.upstream.providers];
    let activeProvider = context.config.upstream.active_provider;

    if (action === "select") {
      if (!providerId || !providers.some((provider) => provider.id === providerId)) {
        throw new Error("unknown_provider");
      }
      activeProvider = providerId;
    } else if (action === "delete") {
      if (!providerId || !providers.some((provider) => provider.id === providerId)) {
        throw new Error("unknown_provider");
      }
      if (providers.length <= 1) {
        throw new Error("last_provider_cannot_be_deleted");
      }
      providers = providers.filter((provider) => provider.id !== providerId);
      if (activeProvider === providerId) {
        activeProvider = providers[0].id;
      }
    } else {
      const id = providerId ?? makeProviderId(readString(upstream, "name") ?? "custom");
      const existing = providers.find((provider) => provider.id === id);
      const provider = {
        ...existing,
        id,
        name: readString(upstream, "name") ?? existing?.name ?? "Custom API",
        protocol: readProtocol(upstream, "protocol") ?? existing?.protocol ?? "openai",
        base_url: readString(upstream, "baseUrl") ?? readString(upstream, "base_url") ?? existing?.base_url ?? "https://api.openai.com",
        api_key:
          upstream.apiKey === undefined && upstream.api_key === undefined
            ? existing?.api_key
            : readOptionalString(upstream, "apiKey") ?? readOptionalString(upstream, "api_key"),
        anthropic_version:
          readString(upstream, "anthropicVersion") ??
          readString(upstream, "anthropic_version") ??
          existing?.anthropic_version ??
          "2023-06-01",
        timeout_ms: readNumber(upstream, "timeoutMs") ?? readNumber(upstream, "timeout_ms") ?? existing?.timeout_ms ?? 120000
      };
      providers = existing ? providers.map((item) => (item.id === id ? provider : item)) : [...providers, provider];
      activeProvider = id;
    }

    const nextConfig = configSchema.parse({
      ...context.config,
      upstream: {
        ...context.config.upstream,
        active_provider: activeProvider,
        providers
      }
    });

    Object.assign(context.config.upstream, nextConfig.upstream);
    writeConfigPatch({ upstream: toPersistedUpstream(nextConfig.upstream) });
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

async function sendTestShock(
  context: UiRouteContext,
  input: { channel: Channel; intensity: number; durationMs: number }
): Promise<{ outcome: "sent" | "blocked" | "error"; dryRun: boolean; message: string }> {
  const timestamp = Date.now();
  const status = context.dglab?.getStatus();
  const safety = context.safety.getStatus();
  const plan: ShockPlan = {
    kind: "shock.plan",
    channel: input.channel,
    intensity: clamp(input.intensity, 0, 1),
    durationMs: clampInteger(input.durationMs, 1, 1000),
    reason: "dglab.test"
  };

  context.bus.emit({ type: "dglab.test", timestamp });

  if (!context.dglab || !status?.enabled) {
    recordShockPlan(context, timestamp, plan, undefined, "error", "dglab_disabled");
    return { outcome: "error", dryRun: safety.dryRun, message: "DG-LAB 未启用" };
  }

  if (!status.connected || !status.bound) {
    recordShockPlan(context, timestamp, plan, undefined, "error", "dglab_not_bound");
    return { outcome: "error", dryRun: safety.dryRun, message: "DG-LAB 尚未完成 APP 配对" };
  }

  const safePlan = context.safety.evaluate(plan);
  if (!safePlan) {
    recordShockPlan(context, timestamp, plan, undefined, "blocked");
    return { outcome: "blocked", dryRun: safety.dryRun, message: "测试电击被安全限制拦截" };
  }

  if (safety.dryRun) {
    recordShockPlan(context, timestamp, plan, safePlan, "sent");
    return { outcome: "sent", dryRun: true, message: "Dry-run 已记录，未发送真实输出" };
  }

  if (!safePlan.channel) {
    recordShockPlan(context, timestamp, plan, safePlan, "blocked", "missing_channel");
    return { outcome: "blocked", dryRun: false, message: "测试电击缺少通道，已拦截" };
  }

  try {
    await context.dglab.clear(safePlan.channel);
    await context.dglab.setStrength(safePlan.channel, Math.round(safePlan.intensity * 100));
    await context.dglab.pulse(safePlan.channel, softPulseWave, safePlan.durationMs);
    recordShockPlan(context, timestamp, plan, safePlan, "sent");
    return { outcome: "sent", dryRun: false, message: "测试电击已发送" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordShockPlan(context, timestamp, plan, safePlan, "error", message);
    return { outcome: "error", dryRun: false, message };
  }
}

function recordShockPlan(
  context: UiRouteContext,
  timestamp: number,
  input: ShockPlan,
  output: ShockPlan | undefined,
  outcome: "sent" | "blocked" | "error",
  error?: string
): void {
  context.shockPlans?.add({
    timestamp,
    eventType: "dglab.test",
    input,
    output,
    outcome,
    error,
    safety: context.safety.getStatus()
  });
}

async function readUiIndex(builtUiRoot: string, legacyUiRoot: string): Promise<string> {
  const builtIndex = join(builtUiRoot, "index.html");
  if (await fileExists(builtIndex)) {
    return readFile(builtIndex, "utf8");
  }
  return readFile(join(legacyUiRoot, "index.html"), "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function buildUiState(context: UiRouteContext) {
  return {
    ok: true,
    service: "coyote-codex-bridge",
    upstream: {
      activeProvider: context.config.upstream.active_provider,
      name: context.config.upstream.name,
      protocol: context.config.upstream.protocol,
      baseUrl: context.config.upstream.base_url,
      hasApiKey: Boolean(context.config.upstream.api_key),
      timeoutMs: context.config.upstream.timeout_ms,
      providers: context.config.upstream.providers.map((provider) => toClientProvider(provider, context.config.upstream.active_provider))
    },
    safety: context.safety.getStatus(),
    policy: toClientPolicy(context.policy.getSettings()),
    dglab: context.dglab?.getStatus() ?? { enabled: false, connected: false, bound: false },
    events: context.bus.getRecent().slice(-20),
    shockPlans: context.shockPlans?.getRecent(20) ?? []
  };
}

function toClientProvider(provider: UpstreamProviderConfig, activeProvider: string) {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.base_url,
    hasApiKey: Boolean(provider.api_key),
    timeoutMs: provider.timeout_ms,
    active: provider.id === activeProvider
  };
}

function toPersistedUpstream(upstream: AppConfig["upstream"]) {
  return {
    active_provider: upstream.active_provider,
    providers: upstream.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      base_url: provider.base_url,
      ...(provider.api_key ? { api_key: provider.api_key } : {}),
      anthropic_version: provider.anthropic_version,
      timeout_ms: provider.timeout_ms
    }))
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readProtocol(source: Record<string, unknown>, key: string): UpstreamProtocol | undefined {
  const value = source[key];
  return value === "openai" || value === "anthropic" || value === "gemini" ? value : undefined;
}

function makeProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "custom"}-${Date.now().toString(36)}`;
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
