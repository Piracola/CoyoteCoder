import type { CoyoteAppContext } from "../../app/context.js";
import type { AppConfig, UpstreamProviderConfig } from "../../config/schema.js";
import { listLanCandidates } from "../../dglab/controller.js";
import { loadDglabWaveforms, type DglabWaveformCatalog } from "../../dglab/waves.js";

export async function buildUiState(context: CoyoteAppContext) {
  const waveformCatalog = await getWaveformCatalog(context);
  return {
    ok: true,
    service: "coyotecoder",
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
    waveforms: buildWaveformState(waveformCatalog),
    // Honour the configured retention rather than a fixed window, but keep a
    // sane cap so the console payload stays small.
    events: context.bus.getRecent().slice(-uiHistoryLimit(context)),
    shockPlans: context.shockPlans?.getRecent(uiHistoryLimit(context)) ?? [],
    lanCandidates: listLanCandidates()
  };
}

const UI_HISTORY_MAX = 200;

function uiHistoryLimit(context: CoyoteAppContext): number {
  return Math.min(UI_HISTORY_MAX, Math.max(20, context.config.privacy.recent_event_limit));
}

export async function getWaveformCatalog(context: CoyoteAppContext): Promise<DglabWaveformCatalog> {
  return context.waveforms ? context.waveforms.getCatalog() : loadDglabWaveforms();
}

export function buildWaveformState(catalog: DglabWaveformCatalog) {
  return {
    directory: catalog.directory,
    directories: catalog.directories,
    items: catalog.waveforms.map((waveform) => ({
      id: waveform.id,
      name: waveform.name,
      source: waveform.source,
      fileName: waveform.fileName,
      sampleCount: waveform.waves.length,
      durationMs: waveform.waves.length * 100,
      preview: decodeWaveformPreview(waveform.waves)
    })),
    errors: catalog.errors
  };
}

export interface WaveformPreview {
  /** Per-slot pulse amplitude, 0-100. */
  amplitude: number[];
  /** Per-slot pulse frequency byte. */
  frequency: number[];
}

/**
 * A DG-LAB V3 sample is 16 hex chars: four frequency bytes followed by four
 * amplitude bytes, each covering 25ms. Decoding here lets the console draw the
 * waveform instead of showing a bare hex string.
 */
export function decodeWaveformPreview(waves: string[]): WaveformPreview {
  const amplitude: number[] = [];
  const frequency: number[] = [];

  for (const sample of waves) {
    const hex = sample.trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(hex)) {
      continue;
    }
    for (let slot = 0; slot < 4; slot += 1) {
      frequency.push(Number.parseInt(hex.slice(slot * 2, slot * 2 + 2), 16));
      amplitude.push(Number.parseInt(hex.slice(8 + slot * 2, 8 + slot * 2 + 2), 16));
    }
  }

  return { amplitude, frequency };
}

export function toClientProvider(provider: UpstreamProviderConfig, activeProvider: string) {
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

/**
 * writeConfigPatch merges at the top level only, so this must reproduce every
 * upstream key that should survive a console save — anything omitted is erased
 * from config.yaml.
 */
export function toPersistedUpstream(upstream: AppConfig["upstream"]) {
  return {
    active_provider: upstream.active_provider,
    stream_idle_timeout_ms: upstream.stream_idle_timeout_ms,
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

export function toPersistedSafety(safety: AppConfig["safety"]) {
  return {
    dry_run: safety.dry_run,
    armed: safety.armed,
    channel_limits: { ...safety.channel_limits },
    max_continuous_output_ms: safety.max_continuous_output_ms,
    max_events_per_minute: safety.max_events_per_minute,
    panic_zero_on_exit: safety.panic_zero_on_exit,
    max_intensity_step: safety.max_intensity_step,
    min_interval_ms: safety.min_interval_ms,
    max_session_ms: safety.max_session_ms,
    idle_disarm_ms: safety.idle_disarm_ms,
    respect_device_soft_limit: safety.respect_device_soft_limit
  };
}

function toClientPolicy(policy: AppConfig["policy"]) {
  return {
    requestStarted: {
      channel: policy.request_started.channel,
      coefficient: policy.request_started.coefficient,
      durationMs: policy.request_started.duration_ms,
      waveformId: policy.request_started.waveform_id
    },
    responseStarted: {
      channel: policy.response_started.channel,
      coefficient: policy.response_started.coefficient,
      durationMs: policy.response_started.duration_ms,
      waveformId: policy.response_started.waveform_id
    },
    responseChunk: {
      channel: policy.response_chunk.channel,
      coefficient: policy.response_chunk.coefficient,
      microIntensity: policy.response_chunk.micro_intensity,
      durationMs: policy.response_chunk.duration_ms,
      waveformId: policy.response_chunk.waveform_id
    },
    responseDone: {
      channel: policy.response_done.channel,
      coefficient: policy.response_done.coefficient,
      durationMs: policy.response_done.duration_ms,
      tokenTarget: policy.response_done.token_target,
      waveformId: policy.response_done.waveform_id
    },
    responseToolCall: {
      channel: policy.response_tool_call.channel,
      coefficient: policy.response_tool_call.coefficient,
      durationMs: policy.response_tool_call.duration_ms,
      waveformId: policy.response_tool_call.waveform_id
    },
    responseErrorStatus: {
      channel: policy.response_error_status.channel,
      coefficient: policy.response_error_status.coefficient,
      durationMs: policy.response_error_status.duration_ms,
      waveformId: policy.response_error_status.waveform_id
    }
  };
}
