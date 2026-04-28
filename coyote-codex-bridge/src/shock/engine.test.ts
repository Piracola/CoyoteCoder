import { describe, expect, it } from "vitest";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import { ShockEngine } from "./engine.js";
import { ShockPlanStore } from "./planStore.js";
import { ShockPolicy } from "./policy.js";
import { SafetyGate } from "./safety.js";
import type { ShockSink, ShockPlan } from "./types.js";

class CapturingSink implements ShockSink {
  readonly plans: ShockPlan[] = [];

  send(plan: ShockPlan): void {
    this.plans.push(plan);
  }
}

describe("ShockEngine", () => {
  it("records sent plans with safety-adjusted output", async () => {
    const config = configSchema.parse({});
    const bus = new EventBus(20);
    const sink = new CapturingSink();
    const store = new ShockPlanStore(20);
    const engine = new ShockEngine(bus, new ShockPolicy(config.policy), new SafetyGate(config.safety), sink, store);

    await engine.emitPlansFor({
      type: "response.chunk",
      requestId: "req_test",
      timestamp: 1_000,
      bytes: 600,
      chars: 600,
      deltaMs: 100,
      cumulativeChars: 600,
      streamRateCharsPerSec: 6000
    });

    expect(sink.plans).toHaveLength(1);
    expect(store.getRecent()).toMatchObject([
      {
        eventType: "response.chunk",
        requestId: "req_test",
        outcome: "sent",
        input: { kind: "shock.plan", channel: "B" },
        output: { kind: "shock.plan", channel: "B", intensity: 0.1 }
      }
    ]);
  });

  it("records blocked plans when safety rejects output", async () => {
    const config = configSchema.parse({ safety: { dry_run: false, armed: false } });
    const bus = new EventBus(20);
    const sink = new CapturingSink();
    const store = new ShockPlanStore(20);
    const engine = new ShockEngine(bus, new ShockPolicy(config.policy), new SafetyGate(config.safety), sink, store);

    await engine.emitPlansFor({
      type: "request.started",
      requestId: "req_blocked",
      timestamp: 1_000
    });

    expect(sink.plans).toEqual([]);
    expect(store.getRecent()).toMatchObject([
      {
        eventType: "request.started",
        requestId: "req_blocked",
        outcome: "blocked",
        output: undefined
      }
    ]);
  });
});
