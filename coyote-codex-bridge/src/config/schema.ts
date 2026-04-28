import { z } from "zod";

const channelSchema = z.enum(["A", "B"]);
const upstreamProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
const objectWithDefaults = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess((value) => value ?? {}, z.object(shape));

const upstreamProviderSchema = z.object({
  id: z.string().trim().min(1).default("openai"),
  name: z.string().trim().min(1).default("OpenAI"),
  protocol: upstreamProtocolSchema.default("openai"),
  base_url: z.string().url().default("https://api.openai.com"),
  api_key: z.string().trim().optional(),
  anthropic_version: z.string().trim().min(1).default("2023-06-01"),
  timeout_ms: z.coerce.number().int().positive().default(120000)
});

const upstreamSchema = z.preprocess(
  normalizeUpstreamConfig,
  z.object({
    active_provider: z.string().trim().min(1),
    providers: z.array(upstreamProviderSchema).min(1),
    id: z.string().trim().min(1).default("openai"),
    name: z.string().trim().min(1).default("OpenAI"),
    protocol: upstreamProtocolSchema.default("openai"),
    base_url: z.string().url().default("https://api.openai.com"),
    api_key: z.string().trim().optional(),
    anthropic_version: z.string().trim().min(1).default("2023-06-01"),
    timeout_ms: z.coerce.number().int().positive().default(120000)
  })
);

export const configSchema = z.object({
  server: objectWithDefaults({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65535).default(8787)
  }),
  upstream: upstreamSchema,
  privacy: objectWithDefaults({
    store_raw_content: z.boolean().default(false),
    recent_event_limit: z.coerce.number().int().min(1).max(5000).default(200)
  }),
  safety: objectWithDefaults({
    dry_run: z.boolean().default(true),
    armed: z.boolean().default(false),
    channel_limits: objectWithDefaults({
      A: z.coerce.number().int().min(0).max(100).default(15),
      B: z.coerce.number().int().min(0).max(100).default(10)
    }),
    min_event_interval_ms: z.coerce.number().int().min(0).default(150),
    max_continuous_output_ms: z.coerce.number().int().min(1).default(3000),
    max_events_per_minute: z.coerce.number().int().min(1).default(120),
    panic_zero_on_exit: z.boolean().default(true)
  }),
  policy: objectWithDefaults({
    request_started: objectWithDefaults({
      channel: channelSchema.default("A"),
      intensity: z.number().min(0).max(1).default(0.08),
      duration_ms: z.coerce.number().int().positive().default(120)
    }),
    response_started: objectWithDefaults({
      channel: channelSchema.default("B"),
      intensity: z.number().min(0).max(1).default(0.08),
      duration_ms: z.coerce.number().int().positive().default(120)
    }),
    response_chunk: objectWithDefaults({
      channel: channelSchema.default("B"),
      min_intensity: z.number().min(0).max(1).default(0.04),
      max_intensity: z.number().min(0).max(1).default(0.35),
      duration_ms: z.coerce.number().int().positive().default(120),
      rate_window_ms: z.coerce.number().int().positive().default(1000)
    }),
    response_done: objectWithDefaults({
      channel: channelSchema.default("A"),
      intensity: z.number().min(0).max(1).default(0.06),
      duration_ms: z.coerce.number().int().positive().default(180)
    })
  }),
  dglab: objectWithDefaults({
    enabled: z.boolean().default(true),
    socket_url: z.string().default("ws://127.0.0.1:9999"),
    qr_host: z.string().default("auto"),
    qr_port: z.coerce.number().int().min(1).max(65535).default(9999),
    default_channels: objectWithDefaults({
      request: channelSchema.default("A"),
      response: channelSchema.default("B")
    })
  })
});

export type AppConfig = z.infer<typeof configSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type UpstreamProtocol = z.infer<typeof upstreamProtocolSchema>;
export type UpstreamProviderConfig = z.infer<typeof upstreamProviderSchema>;

function normalizeUpstreamConfig(value: unknown): Record<string, unknown> {
  const raw = isRecord(value) ? value : {};
  const rawProviders = Array.isArray(raw.providers) ? raw.providers.filter(isRecord) : [];
  const providers = rawProviders.length > 0 ? rawProviders : [legacyProviderFrom(raw)];
  const activeId = readString(raw, "active_provider") ?? readString(raw, "id") ?? readString(providers[0], "id") ?? "openai";
  const activeProvider = providers.find((provider) => readString(provider, "id") === activeId) ?? providers[0];
  const normalizedActiveId = readString(activeProvider, "id") ?? activeId;

  return {
    ...raw,
    ...activeProvider,
    active_provider: normalizedActiveId,
    providers
  };
}

function legacyProviderFrom(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: readString(raw, "id") ?? "openai",
    name: raw.name,
    protocol: raw.protocol,
    base_url: raw.base_url,
    api_key: raw.api_key,
    anthropic_version: raw.anthropic_version,
    timeout_ms: raw.timeout_ms
  };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
