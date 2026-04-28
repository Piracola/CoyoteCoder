import { z } from "zod";

const channelSchema = z.enum(["A", "B"]);
const upstreamProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
const objectWithDefaults = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.preprocess((value) => value ?? {}, z.object(shape));

export const configSchema = z.object({
  server: objectWithDefaults({
    host: z.string().default("127.0.0.1"),
    port: z.coerce.number().int().min(1).max(65535).default(8787)
  }),
  upstream: objectWithDefaults({
    name: z.string().min(1).default("OpenAI"),
    protocol: upstreamProtocolSchema.default("openai"),
    base_url: z.string().url().default("https://api.openai.com"),
    api_key_env: z.string().default("OPENAI_API_KEY"),
    api_key: z.string().optional(),
    anthropic_version: z.string().min(1).default("2023-06-01"),
    timeout_ms: z.coerce.number().int().positive().default(120000)
  }),
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
    enabled: z.boolean().default(false),
    socket_url: z.string().default("ws://127.0.0.1:9999"),
    qr_host: z.string().default("127.0.0.1"),
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
