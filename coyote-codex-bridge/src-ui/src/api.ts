export type Channel = "A" | "B";
export type UpstreamProtocol = "openai" | "anthropic" | "gemini";

export interface PulsePolicy {
  channel: Channel;
  intensity: number;
  durationMs: number;
}

export interface ChunkPolicy {
  channel: Channel;
  minIntensity: number;
  maxIntensity: number;
  durationMs: number;
  rateWindowMs: number;
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
    minEventIntervalMs: number;
    maxContinuousOutputMs: number;
    maxEventsPerMinute: number;
    recentEventsInWindow?: number;
  };
  policy: {
    requestStarted: PulsePolicy;
    responseStarted: PulsePolicy;
    responseChunk: ChunkPolicy;
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
    strengths?: Record<Channel, number>;
  };
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
}

export interface ShockPlanRecord {
  timestamp: number;
  eventType: string;
  outcome: "sent" | "blocked" | "dry_run" | "error" | string;
  error?: string;
  input?: ShockPlan;
  output?: ShockPlan;
}

export interface ShockPlan {
  channel?: Channel;
  intensity?: number;
  durationMs?: number;
  kind?: string;
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
    minEventIntervalMs: number;
    maxContinuousOutputMs: number;
    maxEventsPerMinute: number;
  };
  policy: UiState["policy"];
}

const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
const isTauri = Boolean(tauriWindow.__TAURI_INTERNALS__);
export const API_BASE = import.meta.env.VITE_COYOTE_API_BASE ?? (isTauri ? "http://127.0.0.1:8787" : "");

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
      minEventIntervalMs: state.safety.minEventIntervalMs,
      maxContinuousOutputMs: state.safety.maxContinuousOutputMs,
      maxEventsPerMinute: state.safety.maxEventsPerMinute
    },
    policy: {
      requestStarted: { ...state.policy.requestStarted },
      responseStarted: { ...state.policy.responseStarted },
      responseChunk: { ...state.policy.responseChunk },
      responseDone: { ...state.policy.responseDone }
    }
  };
}
