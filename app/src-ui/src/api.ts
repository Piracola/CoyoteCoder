export type Channel = "A" | "B";
export type UpstreamProtocol = "openai" | "anthropic" | "gemini";

export interface PulsePolicy {
  channel: Channel;
  coefficient: number;
  durationMs: number;
  /** Only meaningful on responseDone. */
  tokenTarget?: number;
  waveformId?: string | null;
}

export interface ChunkPolicy {
  channel: Channel;
  coefficient: number;
  microIntensity: number;
  durationMs: number;
  waveformId?: string | null;
}

export interface WaveformPreview {
  /** Pulse amplitude per 25ms slot, 0-100. */
  amplitude: number[];
  frequency: number[];
}

export interface WaveformSummary {
  id: string;
  name: string;
  source: "builtin" | "file";
  fileName?: string;
  sampleCount: number;
  durationMs: number;
  preview?: WaveformPreview;
}

export interface LanCandidate {
  address: string;
  interfaceName: string;
  score: number;
  likelyVirtual: boolean;
}

export interface WaveformState {
  directory: string;
  directories: string[];
  items: WaveformSummary[];
  errors: Array<{
    fileName?: string;
    directory?: string;
    message: string;
  }>;
}

export interface UiState {
  ok: boolean;
  service: string;
  upstream: {
    activeProvider?: string;
    name?: string;
    protocol?: UpstreamProtocol;
    baseUrl?: string;
    hasApiKey?: boolean;
    timeoutMs?: number;
    providers?: ProviderSummary[];
  };
  safety: {
    dryRun: boolean;
    armed: boolean;
    panic?: boolean;
    channelLimits: Record<Channel, number>;
    /** Config limit intersected with the device-reported soft limit. */
    effectiveLimits?: Record<Channel, number>;
    deviceSoftLimits?: Record<Channel, number>;
    maxContinuousOutputMs: number;
    maxEventsPerMinute: number;
    recentEventsInWindow?: number;
    maxIntensityStep?: number;
    minIntervalMs?: number;
    maxSessionMs?: number;
    idleDisarmMs?: number;
    armedForMs?: number;
    sessionRemainingMs?: number;
    idleRemainingMs?: number;
    lastIntensity?: Record<Channel, number>;
    lastBlockReason?: string;
  };
  policy: {
    requestStarted: PulsePolicy;
    responseStarted: PulsePolicy;
    responseChunk: ChunkPolicy;
    responseToolCall: PulsePolicy;
    responseErrorStatus: PulsePolicy;
    responseDone: PulsePolicy;
  };
  dglab: {
    enabled: boolean;
    connected: boolean;
    bound: boolean;
    clientId?: string;
    targetId?: string;
    socketUrl?: string;
    qrLink?: string;
    lastError?: string;
    strengths?: {
      A: number;
      B: number;
      softLimitA: number;
      softLimitB: number;
    };
  };
  waveforms: WaveformState;
  lanCandidates?: LanCandidate[];
  testShock?: {
    outcome: "sent" | "blocked" | "error";
    dryRun: boolean;
    message: string;
  };
  events: RuntimeEvent[];
  shockPlans: ShockPlanRecord[];
}

export interface RuntimeEvent {
  type: string;
  timestamp: number;
  requestId?: string;
  model?: string;
  chars?: number;
  bytes?: number;
  message?: string;
  endpoint?: string;
  stream?: boolean;
  statusCode?: number;
  durationMs?: number;
  deltaMs?: number;
  cumulativeChars?: number;
  streamRateCharsPerSec?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedTokens?: boolean;
  finishReason?: string;
  toolCallCount?: number;
  toolNames?: string[];
}

export interface ShockPlanRecord {
  timestamp: number;
  eventType: string;
  outcome: "sent" | "blocked" | "dry_run" | "error" | string;
  error?: string;
  safety?: {
    dryRun?: boolean;
  };
  input?: ShockPlan;
  output?: ShockPlan;
}

export interface ShockPlan {
  channel?: Channel;
  intensity?: number;
  durationMs?: number;
  kind?: string;
  waveId?: string;
  continuous?: boolean;
}

export interface ProviderSummary {
  id: string;
  name: string;
  protocol: UpstreamProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  timeoutMs: number;
  active: boolean;
}

export interface ProviderDraft {
  id: string;
  name: string;
  protocol: UpstreamProtocol;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface SettingsDraft {
  dryRun: boolean;
  safety: {
    channelLimits: Record<Channel, number>;
    maxContinuousOutputMs: number;
    maxEventsPerMinute: number;
    maxIntensityStep: number;
    minIntervalMs: number;
    maxSessionMs: number;
    idleDisarmMs: number;
  };
  policy: UiState["policy"];
}

const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
const isTauri = Boolean(tauriWindow.__TAURI_INTERNALS__);
export const API_BASE = import.meta.env.VITE_COYOTE_API_BASE ?? (isTauri ? "http://127.0.0.1:8787" : "");
export const isDesktopRuntime = isTauri;

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? payload?.message ?? `请求失败: ${response.status}`);
  }
  return payload as T;
}

export interface StreamHandlers {
  onState: (state: UiState) => void;
  onEvent: (event: RuntimeEvent) => void;
  onStatusChange: (connected: boolean) => void;
}

/**
 * Subscribes to the console's live feed. Falls back to nothing if the browser
 * cannot open the stream; callers keep a slow poll as a safety net.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToUiStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retryTimer: number | undefined;
  let closed = false;
  let retryDelayMs = 1000;

  const connect = () => {
    if (closed) return;
    source = new EventSource(apiUrl("/ui/stream"));

    source.addEventListener("open", () => {
      retryDelayMs = 1000;
      handlers.onStatusChange(true);
    });

    source.addEventListener("state", (message) => {
      try {
        handlers.onState(JSON.parse((message as MessageEvent<string>).data) as UiState);
      } catch {
        // A malformed frame should not tear the stream down.
      }
    });

    source.addEventListener("event", (message) => {
      try {
        handlers.onEvent(JSON.parse((message as MessageEvent<string>).data) as RuntimeEvent);
      } catch {
        // ignore
      }
    });

    source.addEventListener("error", () => {
      handlers.onStatusChange(false);
      source?.close();
      source = null;
      if (closed) return;
      // EventSource retries on its own, but only for some failure modes;
      // reconnecting explicitly with backoff covers the rest.
      retryTimer = window.setTimeout(connect, retryDelayMs);
      retryDelayMs = Math.min(15000, retryDelayMs * 2);
    });
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    source?.close();
  };
}

export async function getRunInBackground(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("get_run_in_background");
}

export async function setRunInBackground(enabled: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_run_in_background", { enabled });
}

export function providerFromState(state: UiState): ProviderDraft {
  return {
    id: state.upstream.activeProvider ?? state.upstream.providers?.find((provider) => provider.active)?.id ?? "openai",
    name: state.upstream.name ?? "",
    protocol: state.upstream.protocol ?? "openai",
    baseUrl: state.upstream.baseUrl ?? "",
    apiKey: "",
    timeoutMs: state.upstream.timeoutMs ?? 120000
  };
}

export function providerFromSummary(provider: ProviderSummary): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: "",
    timeoutMs: provider.timeoutMs
  };
}

export function settingsFromState(state: UiState): SettingsDraft {
  return {
    dryRun: state.safety.dryRun,
    safety: {
      channelLimits: {
        A: state.safety.channelLimits.A,
        B: state.safety.channelLimits.B
      },
      maxContinuousOutputMs: state.safety.maxContinuousOutputMs,
      maxEventsPerMinute: state.safety.maxEventsPerMinute,
      maxIntensityStep: state.safety.maxIntensityStep ?? 0.2,
      minIntervalMs: state.safety.minIntervalMs ?? 150,
      maxSessionMs: state.safety.maxSessionMs ?? 1_800_000,
      idleDisarmMs: state.safety.idleDisarmMs ?? 300_000
    },
    policy: {
      requestStarted: { ...state.policy.requestStarted },
      responseStarted: { ...state.policy.responseStarted },
      responseChunk: { ...state.policy.responseChunk },
      responseToolCall: { ...state.policy.responseToolCall },
      responseErrorStatus: { ...state.policy.responseErrorStatus },
      responseDone: { ...state.policy.responseDone }
    }
  };
}
