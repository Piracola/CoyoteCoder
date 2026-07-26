import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../config/schema.js";
import { SafetyGate } from "./safety.js";
import type { ShockPlan } from "./types.js";

function safety(overrides: Partial<ReturnType<typeof configSchema.parse>["safety"]> = {}) {
  const config = configSchema.parse({
    safety: {
      max_events_per_minute: 2,
      // Most cases predate the ramp and spacing rules; opt in per test instead.
      max_intensity_step: 1,
      min_interval_ms: 0,
      ...overrides
    }
  });
  return new SafetyGate(config.safety);
}

const plan: ShockPlan = {
  kind: "shock.plan",
  channel: "A",
  intensity: 0.8,
  durationMs: 5000,
  reason: "test"
};

describe("SafetyGate", () => {
  it("allows dry-run plans without arming", () => {
    const gate = safety({ dry_run: true, armed: false });
    expect(gate.evaluate(plan, 1_000)).toMatchObject({ intensity: 0.15, durationMs: 3000 });
  });

  it("blocks real output until armed", () => {
    const gate = safety({ dry_run: false, armed: false });
    expect(gate.evaluate(plan, 1_000)).toBeUndefined();
  });

  it("allows real output when armed", () => {
    const gate = safety({ dry_run: false, armed: true });
    expect(gate.evaluate(plan, 1_000)).toMatchObject({ channel: "A" });
  });

  it("disarms and blocks after panic", () => {
    const gate = safety({ dry_run: false, armed: true });
    expect(gate.panic()).toHaveLength(2);
    expect(gate.getStatus()).toMatchObject({ armed: false, panic: true });
    expect(gate.evaluate(plan, 1_000)).toBeUndefined();
  });

  it("enforces max events per minute", () => {
    const gate = safety({ dry_run: true, max_events_per_minute: 2 });
    expect(gate.evaluate({ ...plan, channel: "A" }, 1_000)).toBeDefined();
    expect(gate.evaluate({ ...plan, channel: "B" }, 1_001)).toBeDefined();
    expect(gate.evaluate({ ...plan, channel: "A" }, 1_002)).toBeUndefined();
    expect(gate.getStatus(1_002).lastBlockReason).toBe("rate_limit");
  });

  it("ramps intensity instead of stepping straight to the ceiling", () => {
    const gate = safety({
      dry_run: true,
      channel_limits: { A: 100, B: 100 },
      max_intensity_step: 0.2,
      max_events_per_minute: 100
    });

    expect(gate.evaluate(plan, 1_000)).toMatchObject({ intensity: 0.2 });
    expect(gate.evaluate(plan, 2_000)).toMatchObject({ intensity: 0.4 });
    expect(gate.evaluate(plan, 3_000)).toMatchObject({ intensity: 0.6 });
  });

  it("resets the ramp baseline after a zero plan", () => {
    const gate = safety({
      dry_run: true,
      channel_limits: { A: 100, B: 100 },
      max_intensity_step: 0.3,
      max_events_per_minute: 100
    });

    expect(gate.evaluate(plan, 1_000)).toMatchObject({ intensity: 0.3 });
    gate.evaluate({ kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "stop" }, 1_100);
    expect(gate.evaluate(plan, 1_200)).toMatchObject({ intensity: 0.3 });
  });

  it("spaces discrete plans on the same channel", () => {
    const gate = safety({ dry_run: true, min_interval_ms: 200, max_events_per_minute: 100 });

    expect(gate.evaluate(plan, 1_000)).toBeDefined();
    expect(gate.evaluate(plan, 1_100)).toBeUndefined();
    expect(gate.getStatus(1_100).lastBlockReason).toBe("min_interval");
    expect(gate.evaluate(plan, 1_250)).toBeDefined();
  });

  it("does not space continuous stream refreshes", () => {
    const gate = safety({ dry_run: true, min_interval_ms: 500, max_events_per_minute: 100 });
    const continuous: ShockPlan = { ...plan, continuous: true };

    expect(gate.evaluate(continuous, 1_000)).toBeDefined();
    expect(gate.evaluate(continuous, 1_050)).toBeDefined();
  });

  it("honours a device soft limit stricter than the configured one", () => {
    const gate = safety({ dry_run: true, channel_limits: { A: 80, B: 80 }, max_events_per_minute: 100 });
    gate.setDeviceSoftLimits({ A: 20, B: 20 });

    expect(gate.evaluate(plan, 1_000)).toMatchObject({ intensity: 0.2 });
    expect(gate.getStatus(1_000).effectiveLimits.A).toBe(20);
  });

  it("ignores a device soft limit looser than the configured one", () => {
    const gate = safety({ dry_run: true, channel_limits: { A: 15, B: 15 }, max_events_per_minute: 100 });
    gate.setDeviceSoftLimits({ A: 90, B: 90 });

    expect(gate.evaluate(plan, 1_000)).toMatchObject({ intensity: 0.15 });
  });

  it("auto-disarms when the armed session outlives its ceiling", () => {
    const gate = safety({ dry_run: false, armed: true, max_session_ms: 10_000, idle_disarm_ms: 0 });
    const listener = vi.fn();
    gate.onAutoDisarm(listener);

    const armedAt = gate.getStatus().armedForMs ?? 0;
    expect(armedAt).toBeLessThan(1_000);

    // getStatus enforces the window lazily using the supplied clock.
    gate.getStatus(Date.now() + 11_000);

    expect(listener).toHaveBeenCalledWith("session_expired");
    expect(gate.getStatus().armed).toBe(false);
    gate.dispose();
  });

  it("disarms when the DG-LAB link drops", () => {
    const gate = safety({ dry_run: false, armed: true });
    const listener = vi.fn();
    gate.onAutoDisarm(listener);

    gate.notifyLinkLost();

    expect(listener).toHaveBeenCalledWith("link_lost");
    expect(gate.getStatus().armed).toBe(false);
    expect(gate.evaluate(plan, 1_000)).toBeUndefined();
    gate.dispose();
  });

  it("never gates the zero path", () => {
    const gate = safety({ dry_run: false, armed: false });
    gate.panic();
    const zero: ShockPlan = { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "panic" };
    expect(gate.evaluate(zero, 1_000)).toEqual(zero);
  });
});
