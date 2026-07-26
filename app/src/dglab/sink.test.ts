import { describe, expect, it, vi } from "vitest";
import type { DglabController } from "./controller.js";
import { DglabSink } from "./sink.js";

function mockController() {
  return {
    zeroAll: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    setStrength: vi.fn(async () => undefined),
    pulse: vi.fn(async () => undefined)
  };
}

describe("DglabSink", () => {
  it("still zeroes the device when disarmed", async () => {
    const controller = mockController();
    const sink = new DglabSink(controller as unknown as DglabController);

    await sink.send(
      { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "panic" },
      { dryRun: false, armed: false }
    );

    // Disarming does not un-latch strength the device already holds, so the
    // de-escalation path must not be gated on armed state.
    expect(controller.zeroAll).toHaveBeenCalledTimes(1);
  });

  it("still clears a channel when disarmed", async () => {
    const controller = mockController();
    const sink = new DglabSink(controller as unknown as DglabController);

    await sink.send(
      { kind: "shock.clear", channel: "B", intensity: 0, durationMs: 0, reason: "stop" },
      { dryRun: false, armed: false }
    );

    expect(controller.clear).toHaveBeenCalledWith("B");
  });

  it("blocks real pulses when disarmed", async () => {
    const controller = mockController();
    const sink = new DglabSink(controller as unknown as DglabController);

    await sink.send(
      { kind: "shock.plan", channel: "A", intensity: 0.2, durationMs: 200, reason: "test" },
      { dryRun: false, armed: false }
    );

    expect(controller.pulse).not.toHaveBeenCalled();
    expect(controller.setStrength).not.toHaveBeenCalled();
  });

  it("sends nothing at all in dry-run, including zeroes", async () => {
    const controller = mockController();
    const sink = new DglabSink(controller as unknown as DglabController);

    await sink.send(
      { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "panic" },
      { dryRun: true, armed: true }
    );

    // Dry-run never emitted anything, so there is nothing to undo.
    expect(controller.zeroAll).not.toHaveBeenCalled();
  });
});
