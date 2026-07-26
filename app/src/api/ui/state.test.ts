import { describe, expect, it } from "vitest";
import { configSchema } from "../../config/schema.js";
import { decodeWaveformPreview, toPersistedSafety, toPersistedUpstream } from "./state.js";

describe("config persistence shapes", () => {
  // writeConfigPatch merges only at the top level, so a key missing from these
  // helpers is silently dropped from config.yaml on the next console save.
  it("round-trips every upstream key the schema defines", () => {
    const config = configSchema.parse({});
    const persisted = toPersistedUpstream(config.upstream);
    const reparsed = configSchema.parse({ upstream: persisted });

    expect(reparsed.upstream.stream_idle_timeout_ms).toBe(config.upstream.stream_idle_timeout_ms);
    expect(reparsed.upstream.active_provider).toBe(config.upstream.active_provider);
  });

  it("round-trips every safety key the schema defines", () => {
    const config = configSchema.parse({
      safety: { max_intensity_step: 0.35, min_interval_ms: 220, max_session_ms: 600_000, idle_disarm_ms: 90_000 }
    });
    const reparsed = configSchema.parse({ safety: toPersistedSafety(config.safety) });

    expect(reparsed.safety).toMatchObject({
      max_intensity_step: 0.35,
      min_interval_ms: 220,
      max_session_ms: 600_000,
      idle_disarm_ms: 90_000,
      respect_device_soft_limit: true
    });
  });
});

describe("decodeWaveformPreview", () => {
  it("splits a V3 sample into four frequency and four amplitude slots", () => {
    const preview = decodeWaveformPreview(["0A0B0C0D64636261"]);

    expect(preview.frequency).toEqual([10, 11, 12, 13]);
    expect(preview.amplitude).toEqual([100, 99, 98, 97]);
  });

  it("skips samples that are not valid 16-char hex", () => {
    const preview = decodeWaveformPreview(["not-hex", "0A0A0A0A64646464"]);

    expect(preview.amplitude).toEqual([100, 100, 100, 100]);
  });
});
