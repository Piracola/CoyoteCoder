import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../../app/context.js";
import { writeConfigPatch } from "../../config/configFile.js";
import { configSchema } from "../../config/schema.js";
import type { PolicySettingsPatch } from "../../shock/policy.js";
import type { SafetySettingsPatch } from "../../shock/safety.js";
import {
  parseJsonBody,
  readBoolean,
  readChannel,
  readNumber,
  readObject,
  readString,
  readWaveformId
} from "./body.js";
import { buildUiState, toPersistedSafety } from "./state.js";

export function registerUiSettingsRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.post("/ui/settings", async (request) => {
    const body = parseJsonBody(request.body);
    const action = readAction(body);
    if (action === "reset-defaults") {
      const defaults = configSchema.parse({});
      const nextConfig = configSchema.parse({
        ...context.config,
        safety: {
          ...context.config.safety,
          channel_limits: { ...defaults.safety.channel_limits },
          max_continuous_output_ms: defaults.safety.max_continuous_output_ms,
          max_events_per_minute: defaults.safety.max_events_per_minute
        },
        policy: defaults.policy
      });

      Object.assign(context.config.safety, nextConfig.safety);
      Object.assign(context.config.policy, nextConfig.policy);
      writeConfigPatch({
        safety: toPersistedSafety(nextConfig.safety),
        policy: nextConfig.policy
      });
      return buildUiState(context);
    }

    const dryRun = readBoolean(body, "dryRun");
    if (dryRun !== undefined) {
      context.safety.setDryRun(dryRun);
      context.config.safety.dry_run = dryRun;
    }

    const safety = readObject(body, "safety");
    if (safety) {
      context.safety.updateSettings(readSafetyPatch(safety));
    }

    const policy = readObject(body, "policy");
    if (policy) {
      context.policy.updateSettings(readPolicyPatch(policy));
    }

    if (dryRun !== undefined || safety || policy) {
      const nextConfig = configSchema.parse({
        ...context.config,
        safety: context.config.safety,
        policy: context.policy.getSettings()
      });
      Object.assign(context.config.safety, nextConfig.safety);
      Object.assign(context.config.policy, nextConfig.policy);
      writeConfigPatch({
        safety: toPersistedSafety(nextConfig.safety),
        policy: nextConfig.policy
      });
    }

    return buildUiState(context);
  });
}

function readAction(body: Record<string, unknown>): string | undefined {
  return readString(body, "action");
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
    maxContinuousOutputMs: readNumber(safety, "maxContinuousOutputMs"),
    maxEventsPerMinute: readNumber(safety, "maxEventsPerMinute"),
    maxIntensityStep: readNumber(safety, "maxIntensityStep"),
    minIntervalMs: readNumber(safety, "minIntervalMs"),
    maxSessionMs: readNumber(safety, "maxSessionMs"),
    idleDisarmMs: readNumber(safety, "idleDisarmMs"),
    respectDeviceSoftLimit: readBoolean(safety, "respectDeviceSoftLimit")
  };
}

function readPolicyPatch(policy: Record<string, unknown>): PolicySettingsPatch {
  return {
    requestStarted: readPulsePatch(policy, "requestStarted"),
    responseStarted: readPulsePatch(policy, "responseStarted"),
    responseDone: readPulsePatch(policy, "responseDone"),
    responseToolCall: readPulsePatch(policy, "responseToolCall"),
    responseErrorStatus: readPulsePatch(policy, "responseErrorStatus"),
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
    coefficient: readNumber(value, "coefficient"),
    durationMs: readNumber(value, "durationMs"),
    // Only response_done consumes this; the policy ignores it elsewhere.
    tokenTarget: readNumber(value, "tokenTarget"),
    waveformId: readWaveformId(value, "waveformId")
  };
}

function readChunkPatch(policy: Record<string, unknown>): PolicySettingsPatch["responseChunk"] {
  const value = readObject(policy, "responseChunk");
  if (!value) {
    return undefined;
  }
  return {
    channel: readChannel(value, "channel"),
    coefficient: readNumber(value, "coefficient"),
    microIntensity: readNumber(value, "microIntensity"),
    durationMs: readNumber(value, "durationMs"),
    waveformId: readWaveformId(value, "waveformId")
  };
}
