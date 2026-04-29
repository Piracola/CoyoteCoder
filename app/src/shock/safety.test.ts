import { describe, expect, it } from "vitest";
import { configSchema } from "../config/schema.js";
import { SafetyGate } from "./safety.js";
import type { ShockPlan } from "./types.js";

function safety(overrides: Partial<ReturnType<typeof configSchema.parse>["safety"]> = {}) {
  const config = configSchema.parse({
    safety: {
      max_events_per_minute: 2,
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
  });
});
