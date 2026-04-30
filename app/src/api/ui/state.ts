import type { CoyoteAppContext } from "../../app/context.js";
import type { AppConfig, UpstreamProviderConfig } from "../../config/schema.js";
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
    events: context.bus.getRecent().slice(-20),
    shockPlans: context.shockPlans?.getRecent(20) ?? []
  };
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
      durationMs: waveform.waves.length * 100
    })),
    errors: catalog.errors
  };
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

export function toPersistedUpstream(upstream: AppConfig["upstream"]) {
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

export function toPersistedSafety(safety: AppConfig["safety"]) {
  return {
    dry_run: safety.dry_run,
    armed: safety.armed,
    channel_limits: { ...safety.channel_limits },
    max_continuous_output_ms: safety.max_continuous_output_ms,
    max_events_per_minute: safety.max_events_per_minute,
    panic_zero_on_exit: safety.panic_zero_on_exit
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
