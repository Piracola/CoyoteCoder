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
        output: { kind: "shock.plan", channel: "B", intensity: 0.1, continuous: true }
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

  it("plans tool-call, error-status, and token-scaled done feedback", async () => {
    const config = configSchema.parse({ safety: { channel_limits: { A: 100, B: 100 } } });
    const bus = new EventBus(20);
    const sink = new CapturingSink();
    const store = new ShockPlanStore(20);
    const engine = new ShockEngine(bus, new ShockPolicy(config.policy), new SafetyGate(config.safety), sink, store);

    await engine.emitPlansFor({
      type: "response.tool_call",
      requestId: "req_tools",
      timestamp: 1_000,
      toolCallCount: 1,
      toolNames: ["edit_file"]
    });
    await engine.emitPlansFor({
      type: "response.error_status",
      requestId: "req_error",
      timestamp: 1_100,
      statusCode: 429,
      message: "rate limited"
    });
    await engine.emitPlansFor({
      type: "response.done",
      requestId: "req_done",
      timestamp: 1_200,
      statusCode: 200,
      outputTokens: 600
    });

    expect(sink.plans).toMatchObject([
      { channel: "A", intensity: 1 / 3, durationMs: 160, reason: "response.tool_call" },
      { channel: "A", intensity: 0.65, durationMs: 220, reason: "response.error_status" },
      { channel: "A", intensity: 0.5, durationMs: 180, reason: "response.done" }
    ]);
    expect(store.getRecent()).toMatchObject([
      { eventType: "response.tool_call", outcome: "sent" },
      { eventType: "response.error_status", outcome: "sent" },
      { eventType: "response.done", outcome: "sent" }
    ]);
  });

  it("keeps weak current for low-signal streaming chunks", async () => {
    const config = configSchema.parse({
      safety: { channel_limits: { A: 100, B: 100 } },
      policy: { response_chunk: { micro_intensity: 0.2, coefficient: 0.5 } }
    });
    const bus = new EventBus(20);
    const sink = new CapturingSink();
    const store = new ShockPlanStore(20);
    const engine = new ShockEngine(bus, new ShockPolicy(config.policy), new SafetyGate(config.safety), sink, store);

    await engine.emitPlansFor({
      type: "response.chunk",
      requestId: "req_stream",
      timestamp: 1_000,
      bytes: 1,
      chars: 1,
      deltaMs: 10_000,
      cumulativeChars: 1,
      streamRateCharsPerSec: 0.1
    });

    expect(sink.plans).toMatchObject([
      { channel: "B", intensity: 0.1, durationMs: 2000, reason: "response.chunk", continuous: true }
    ]);
  });

  it("coalesces rapid streaming chunks before they reach safety limits", async () => {
    const config = configSchema.parse({
      safety: { max_events_per_minute: 2, channel_limits: { A: 100, B: 100 } }
    });
    const bus = new EventBus(20);
    const sink = new CapturingSink();
    const store = new ShockPlanStore(20);
    const engine = new ShockEngine(bus, new ShockPolicy(config.policy), new SafetyGate(config.safety), sink, store);

    for (let index = 0; index < 5; index += 1) {
      await engine.emitPlansFor({
        type: "response.chunk",
        requestId: "req_stream",
        timestamp: 1_000 + index * 100,
        bytes: 20,
        chars: 20,
        deltaMs: 100,
        cumulativeChars: 20 * (index + 1),
        streamRateCharsPerSec: 200
      });
    }

    expect(sink.plans).toHaveLength(1);
    expect(store.getRecent()).toHaveLength(1);
    expect(store.getRecent()[0]).toMatchObject({ eventType: "response.chunk", outcome: "sent" });
  });
});
