import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { configSchema } from "./schema.js";

describe("config schema", () => {
  it("accepts the shipped example config", () => {
    // config.example.yaml is what users copy and what the portable build ships,
    // so a schema change that leaves it stale must fail here.
    const examplePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.example.yaml");
    const raw = YAML.parse(readFileSync(examplePath, "utf8")) as unknown;

    const parsed = configSchema.parse(raw);

    expect(parsed.safety).toMatchObject({
      dry_run: true,
      armed: false,
      panic_zero_on_exit: true,
      respect_device_soft_limit: true
    });
    expect(parsed.safety.max_intensity_step).toBeGreaterThan(0);
    expect(parsed.upstream.stream_idle_timeout_ms).toBeGreaterThan(0);
    expect(parsed.dglab.relay_allow_public).toBe(false);
  });

  it("defaults to a safety posture that blocks real output", () => {
    const config = configSchema.parse({});

    expect(config.safety.dry_run).toBe(true);
    expect(config.safety.armed).toBe(false);
    // Auto-disarm ceilings must be on by default, not opt-in.
    expect(config.safety.max_session_ms).toBeGreaterThan(0);
    expect(config.safety.idle_disarm_ms).toBeGreaterThan(0);
    expect(config.safety.max_intensity_step).toBeLessThan(1);
  });

  it("allows coefficients above 1 so policy can amplify", () => {
    const config = configSchema.parse({ policy: { response_done: { coefficient: 1.5 } } });
    expect(config.policy.response_done.coefficient).toBe(1.5);
  });

  it("keeps micro_intensity within the 0-1 intensity range", () => {
    expect(() => configSchema.parse({ policy: { response_chunk: { micro_intensity: 1.5 } } })).toThrow();
  });

  it("enables DG-LAB pairing by default", () => {
    const config = configSchema.parse({});

    expect(config.dglab).toMatchObject({
      enabled: true,
      socket_url: "ws://127.0.0.1:9999",
      qr_host: "auto",
      qr_port: 9999
    });
    expect(config.upstream).toMatchObject({
      active_provider: "openai",
      base_url: "https://api.openai.com"
    });
    expect(config.safety).toMatchObject({
      dry_run: true,
      armed: false
    });
  });

  it("rejects non-local bind hosts", () => {
    expect(() => configSchema.parse({ server: { host: "0.0.0.0" } })).toThrow();
  });
});
