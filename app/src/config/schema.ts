import { z } from "zod";

const channelSchema = z.enum(["A", "B"]);
const upstreamProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
// Coefficients may amplify as well as attenuate; SafetyGate still clamps the result.
const coefficientSchema = z.coerce.number().min(0).max(2).transform((value) => Math.round(value * 100) / 100);
const intensitySchema = z.coerce.number().min(0).max(1).transform((value) => Math.round(value * 100) / 100);
const waveformIdSchema = z.string().trim().min(1).optional();
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

// Applies to the whole upstream block rather than a single provider: it bounds
// how long a stream may stall after headers arrive, which timeout_ms does not.
const streamIdleTimeoutSchema = z.coerce.number().int().min(0).max(1_800_000).default(180_000);

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
    timeout_ms: z.coerce.number().int().positive().default(120000),
    stream_idle_timeout_ms: streamIdleTimeoutSchema
  })
);

export const configSchema = z.object({
  server: objectWithDefaults({
    host: z.string().default("127.0.0.1").refine(isLocalBindHost, "server.host must be a local loopback host"),
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
    max_continuous_output_ms: z.coerce.number().int().min(1).max(30_000).default(3000),
    max_events_per_minute: z.coerce.number().int().min(1).max(600).default(120),
    panic_zero_on_exit: z.boolean().default(true),
    // Largest intensity increase a single plan may apply per channel.
    max_intensity_step: z.coerce.number().min(0.01).max(1).default(0.2),
    // Minimum spacing between discrete (non-continuous) plans on one channel.
    min_interval_ms: z.coerce.number().int().min(0).max(10_000).default(150),
    // Auto-disarm ceilings; 0 disables the corresponding check.
    max_session_ms: z.coerce.number().int().min(0).max(6 * 3_600_000).default(1_800_000),
    idle_disarm_ms: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
    respect_device_soft_limit: z.boolean().default(true)
  }),
  policy: objectWithDefaults({
    request_started: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(120),
      waveform_id: waveformIdSchema
    }),
    response_started: objectWithDefaults({
      channel: channelSchema.default("B"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(120),
      waveform_id: waveformIdSchema
    }),
    response_chunk: objectWithDefaults({
      channel: channelSchema.default("B"),
      coefficient: coefficientSchema.default(1),
      micro_intensity: intensitySchema.default(0.1),
      duration_ms: z.coerce.number().int().positive().default(2000),
      waveform_id: waveformIdSchema
    }),
    response_tool_call: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(160),
      waveform_id: waveformIdSchema
    }),
    response_error_status: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(220),
      waveform_id: waveformIdSchema
    }),
    response_done: objectWithDefaults({
      channel: channelSchema.default("A"),
      coefficient: coefficientSchema.default(1),
      duration_ms: z.coerce.number().int().positive().default(180),
      token_target: z.coerce.number().int().positive().default(1200),
      waveform_id: waveformIdSchema
    })
  }),
  dglab: objectWithDefaults({
    enabled: z.boolean().default(true),
    socket_url: z.string().default("ws://127.0.0.1:9999"),
    qr_host: z.string().default("auto"),
    qr_port: z.coerce.number().int().min(1).max(65535).default(9999),
    // Bind address for the built-in Socket V2 relay. Phone pairing needs LAN
    // reachability, so this is deliberately wider than server.host; pin it to
    // one interface when the machine also sits on an untrusted network.
    relay_bind_host: z.string().trim().min(1).default("0.0.0.0"),
    // The official DG-LAB app cannot present a shared secret, so the relay
    // instead refuses connections from outside private address ranges.
    relay_allow_public: z.boolean().default(false),
    relay_max_clients: z.coerce.number().int().min(2).max(64).default(8)
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

function isLocalBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
