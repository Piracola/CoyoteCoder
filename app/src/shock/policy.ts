import type { AppConfig } from "../config/schema.js";
import type { CoyoteEvent } from "../events/types.js";
import type { ShockPlan } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const REQUEST_STARTED_BASE_INTENSITY = 0.08;
const RESPONSE_STARTED_BASE_INTENSITY = 0.08;
const FALLBACK_DONE_BASE_INTENSITY = 0.06;

export class ShockPolicy {
  constructor(private readonly config: AppConfig["policy"]) {}

  getSettings(): AppConfig["policy"] {
    return structuredClone(this.config);
  }

  updateSettings(patch: PolicySettingsPatch): void {
    if (patch.requestStarted) {
      updateFeedbackConfig(this.config.request_started, patch.requestStarted);
    }
    if (patch.responseStarted) {
      updateFeedbackConfig(this.config.response_started, patch.responseStarted);
    }
    if (patch.responseDone) {
      updateFeedbackConfig(this.config.response_done, patch.responseDone);
    }
    if (patch.responseToolCall) {
      updateFeedbackConfig(this.config.response_tool_call, patch.responseToolCall);
    }
    if (patch.responseErrorStatus) {
      updateFeedbackConfig(this.config.response_error_status, patch.responseErrorStatus);
    }
    if (patch.responseChunk) {
      if (patch.responseChunk.channel) {
        this.config.response_chunk.channel = patch.responseChunk.channel;
      }
      if (patch.responseChunk.coefficient !== undefined) {
        this.config.response_chunk.coefficient = clampCoefficient(patch.responseChunk.coefficient);
      }
      if (patch.responseChunk.microIntensity !== undefined) {
        this.config.response_chunk.micro_intensity = clampCoefficient(patch.responseChunk.microIntensity);
      }
      if (patch.responseChunk.durationMs !== undefined) {
        this.config.response_chunk.duration_ms = Math.max(1, Math.round(patch.responseChunk.durationMs));
      }
    }
  }

  plan(event: CoyoteEvent): ShockPlan[] {
    switch (event.type) {
      case "request.started":
        return [{
          kind: "shock.plan",
          channel: this.config.request_started.channel,
          intensity: scaledIntensity(REQUEST_STARTED_BASE_INTENSITY, this.config.request_started.coefficient),
          durationMs: this.config.request_started.duration_ms,
          reason: event.type
        }];
      case "response.started":
        return [{
          kind: "shock.plan",
          channel: this.config.response_started.channel,
          intensity: scaledIntensity(RESPONSE_STARTED_BASE_INTENSITY, this.config.response_started.coefficient),
          durationMs: this.config.response_started.duration_ms,
          reason: event.type
        }];
      case "response.chunk": {
        const charsFactor = clamp(event.chars / 800, 0, 1);
        const rateFactor = clamp(event.streamRateCharsPerSec / 1200, 0, 1);
        const dynamicIntensity = clamp(charsFactor * 0.45 + rateFactor * 0.55, 0, 1);
        const baseIntensity = Math.max(this.config.response_chunk.micro_intensity, dynamicIntensity);
        return [{
          kind: "shock.plan",
          channel: this.config.response_chunk.channel,
          intensity: scaledIntensity(baseIntensity, this.config.response_chunk.coefficient),
          durationMs: this.config.response_chunk.duration_ms,
          reason: event.type
        }];
      }
      case "response.tool_call":
        return [{
          kind: "shock.plan",
          channel: this.config.response_tool_call.channel,
          intensity: scaledIntensity(toolCallBaseIntensity(event.toolCallCount), this.config.response_tool_call.coefficient),
          durationMs: this.config.response_tool_call.duration_ms,
          reason: event.type
        }];
      case "response.error_status":
        return [{
          kind: "shock.plan",
          channel: this.config.response_error_status.channel,
          intensity: scaledIntensity(errorStatusBaseIntensity(event.statusCode), this.config.response_error_status.coefficient),
          durationMs: this.config.response_error_status.duration_ms,
          reason: event.type
        }];
      case "response.done":
        return [{
          kind: "shock.plan",
          channel: this.config.response_done.channel,
          intensity: scaledIntensity(responseDoneBaseIntensity(this.config.response_done, event.outputTokens), this.config.response_done.coefficient),
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
  responseToolCall?: PulseSettingsPatch;
  responseErrorStatus?: PulseSettingsPatch;
  responseChunk?: {
    channel?: "A" | "B";
    coefficient?: number;
    microIntensity?: number;
    durationMs?: number;
  };
}

interface PulseSettingsPatch {
  channel?: "A" | "B";
  coefficient?: number;
  durationMs?: number;
}

function responseDoneBaseIntensity(
  config: AppConfig["policy"]["response_done"],
  outputTokens: number | undefined
): number {
  if (outputTokens === undefined) {
    return FALLBACK_DONE_BASE_INTENSITY;
  }
  return clamp(outputTokens / config.token_target, 0, 1);
}

function toolCallBaseIntensity(toolCallCount: number): number {
  return clamp(toolCallCount / 3, 0, 1);
}

function errorStatusBaseIntensity(statusCode: number): number {
  if (statusCode >= 500) {
    return 0.75;
  }
  if (statusCode === 429) {
    return 0.65;
  }
  return 0.5;
}

function scaledIntensity(baseIntensity: number, coefficient: number): number {
  return clamp(baseIntensity * coefficient, 0, 1);
}

function updateFeedbackConfig(
  config: { channel: "A" | "B"; coefficient: number; duration_ms: number },
  patch: PulseSettingsPatch
): void {
  if (patch.channel) {
    config.channel = patch.channel;
  }
  if (patch.coefficient !== undefined) {
    config.coefficient = clampCoefficient(patch.coefficient);
  }
  if (patch.durationMs !== undefined) {
    config.duration_ms = Math.max(1, Math.round(patch.durationMs));
  }
}

function clampCoefficient(value: number): number {
  return Math.round(clamp(value, 0, 1) * 10) / 10;
}
