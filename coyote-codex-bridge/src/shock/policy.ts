import type { AppConfig } from "../config/schema.js";
import type { CoyoteEvent } from "../events/types.js";
import type { ShockPlan } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class ShockPolicy {
  constructor(private readonly config: AppConfig["policy"]) {}

  getSettings(): AppConfig["policy"] {
    return structuredClone(this.config);
  }

  updateSettings(patch: PolicySettingsPatch): void {
    if (patch.requestStarted) {
      updatePulseConfig(this.config.request_started, patch.requestStarted);
    }
    if (patch.responseStarted) {
      updatePulseConfig(this.config.response_started, patch.responseStarted);
    }
    if (patch.responseDone) {
      updatePulseConfig(this.config.response_done, patch.responseDone);
    }
    if (patch.responseChunk) {
      if (patch.responseChunk.channel) {
        this.config.response_chunk.channel = patch.responseChunk.channel;
      }
      if (patch.responseChunk.minIntensity !== undefined) {
        this.config.response_chunk.min_intensity = clamp(patch.responseChunk.minIntensity, 0, 1);
      }
      if (patch.responseChunk.maxIntensity !== undefined) {
        this.config.response_chunk.max_intensity = clamp(patch.responseChunk.maxIntensity, 0, 1);
      }
      if (this.config.response_chunk.max_intensity < this.config.response_chunk.min_intensity) {
        this.config.response_chunk.max_intensity = this.config.response_chunk.min_intensity;
      }
      if (patch.responseChunk.durationMs !== undefined) {
        this.config.response_chunk.duration_ms = Math.max(1, Math.round(patch.responseChunk.durationMs));
      }
      if (patch.responseChunk.rateWindowMs !== undefined) {
        this.config.response_chunk.rate_window_ms = Math.max(1, Math.round(patch.responseChunk.rateWindowMs));
      }
    }
  }

  plan(event: CoyoteEvent): ShockPlan[] {
    switch (event.type) {
      case "request.started":
        return [{
          kind: "shock.plan",
          channel: this.config.request_started.channel,
          intensity: this.config.request_started.intensity,
          durationMs: this.config.request_started.duration_ms,
          reason: event.type
        }];
      case "response.started":
        return [{
          kind: "shock.plan",
          channel: this.config.response_started.channel,
          intensity: this.config.response_started.intensity,
          durationMs: this.config.response_started.duration_ms,
          reason: event.type
        }];
      case "response.chunk": {
        const charsFactor = clamp(event.chars / 800, 0, 1);
        const rateFactor = clamp(event.streamRateCharsPerSec / 1200, 0, 1);
        const intensity = clamp(
          this.config.response_chunk.min_intensity + (charsFactor * 0.45 + rateFactor * 0.55) *
            (this.config.response_chunk.max_intensity - this.config.response_chunk.min_intensity),
          this.config.response_chunk.min_intensity,
          this.config.response_chunk.max_intensity
        );
        return [{
          kind: "shock.plan",
          channel: this.config.response_chunk.channel,
          intensity,
          durationMs: this.config.response_chunk.duration_ms,
          reason: event.type
        }];
      }
      case "response.done":
        return [{
          kind: "shock.plan",
          channel: this.config.response_done.channel,
          intensity: this.config.response_done.intensity,
          durationMs: this.config.response_done.duration_ms,
          reason: event.type
        }];
      case "response.error":
      case "response.aborted":
      case "safety.panic":
        return [
          { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: event.type },
          { kind: "shock.zero", channel: "B", intensity: 0, durationMs: 0, reason: event.type }
        ];
      default:
        return [];
    }
  }
}

export interface PolicySettingsPatch {
  requestStarted?: PulseSettingsPatch;
  responseStarted?: PulseSettingsPatch;
  responseDone?: PulseSettingsPatch;
  responseChunk?: {
    channel?: "A" | "B";
    minIntensity?: number;
    maxIntensity?: number;
    durationMs?: number;
    rateWindowMs?: number;
  };
}

interface PulseSettingsPatch {
  channel?: "A" | "B";
  intensity?: number;
  durationMs?: number;
}

function updatePulseConfig(
  config: { channel: "A" | "B"; intensity: number; duration_ms: number },
  patch: PulseSettingsPatch
): void {
  if (patch.channel) {
    config.channel = patch.channel;
  }
  if (patch.intensity !== undefined) {
    config.intensity = clamp(patch.intensity, 0, 1);
  }
  if (patch.durationMs !== undefined) {
    config.duration_ms = Math.max(1, Math.round(patch.durationMs));
  }
}
