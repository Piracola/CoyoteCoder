import type { EventBus } from "../events/bus.js";
import type { CoyoteEvent } from "../events/types.js";
import type { ShockPlanStore } from "./planStore.js";
import { ShockPolicy } from "./policy.js";
import { SafetyGate } from "./safety.js";
import type { ShockPlan, ShockSink } from "./types.js";

const STOP_EVENTS = new Set<CoyoteEvent["type"]>(["response.error", "response.aborted", "safety.panic"]);
const CONTINUOUS_PLAN_TTL_MS = 300_000;

export class ShockEngine {
  private readonly lastContinuousPlanAt = new Map<string, number>();
  /**
   * Sends are serialized through this chain. A DG-LAB output is a
   * clear/setStrength/pulse triplet, so letting two events interleave on the
   * wire would deliver a mix of both plans to the device.
   */
  private chain: Promise<void> = Promise.resolve();
  /**
   * Bumped by every stop event. Work queued before a stop is dropped rather
   * than sent after it, so panic cannot be followed by a stale pulse.
   */
  private generation = 0;

  constructor(
    bus: EventBus,
    private readonly policy: ShockPolicy,
    private readonly safety: SafetyGate,
    private readonly sink: ShockSink,
    private readonly planStore?: ShockPlanStore
  ) {
    bus.onEvent((event) => {
      this.enqueue(event);
    });
  }

  async emitPlansFor(event: CoyoteEvent): Promise<void> {
    this.enqueue(event);
    await this.chain;
  }

  /** Resolves once every queued send has settled. */
  async drain(): Promise<void> {
    // Awaited twice: a settling step can append more work (an auto-disarm
    // listener emits onto the bus, which enqueues), and the first await would
    // only cover the snapshot taken before that happened.
    await this.chain;
    await this.chain;
  }

  /**
   * Sends an already-gated plan through the same serialized chain. Console
   * actions use this so they cannot interleave with an in-flight triplet.
   */
  async sendGatedPlan(plan: ShockPlan): Promise<void> {
    const run = this.chain.then(() => this.sink.send(plan, this.safety.getStatus()));
    // Keep the chain alive even if this send rejects; the caller still sees it.
    this.chain = run.catch(() => undefined);
    await run;
  }

  private enqueue(event: CoyoteEvent): void {
    const isStop = STOP_EVENTS.has(event.type);
    if (isStop) {
      this.generation += 1;
    }
    const scheduledGeneration = this.generation;

    this.chain = this.chain.then(async () => {
      if (!isStop && scheduledGeneration !== this.generation) {
        return;
      }
      await this.handle(event);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ kind: "shock.queue_error", event: event.type, message }));
    });
  }

  private async handle(event: CoyoteEvent): Promise<void> {
    const plans = this.policy.plan(event);
    for (const plan of plans) {
      if (this.shouldSkipContinuousPlan(event, plan)) {
        continue;
      }

      const safePlan = this.safety.evaluate(plan);
      if (!safePlan) {
        this.record(event, plan, undefined, "blocked");
        continue;
      }

      try {
        await this.sink.send(safePlan, this.safety.getStatus());
        this.record(event, plan, safePlan, "sent");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.record(event, plan, safePlan, "error", message);
        console.error(JSON.stringify({ kind: "shock.error", reason: safePlan.reason, message }));
        // A partial triplet can leave strength latched on the device, so make
        // a best-effort attempt to bring the channel back to zero.
        await this.zeroAfterFailure(safePlan);
      }
    }

    if (event.type === "response.done" || event.type === "response.error" || event.type === "response.aborted") {
      this.clearContinuousPlans(event.requestId);
    }
  }

  private async zeroAfterFailure(failed: ShockPlan): Promise<void> {
    if (failed.kind !== "shock.plan" || !failed.channel) {
      return;
    }
    try {
      await this.sink.send(
        { kind: "shock.zero", channel: failed.channel, intensity: 0, durationMs: 0, reason: "send_failed" },
        this.safety.getStatus()
      );
    } catch {
      // The link is already broken; nothing further can be done from here.
    }
  }

  private shouldSkipContinuousPlan(event: CoyoteEvent, plan: ShockPlan): boolean {
    if (!plan.continuous || !plan.channel) {
      return false;
    }

    const key = `${event.requestId ?? "global"}:${plan.channel}`;
    const now = event.timestamp || Date.now();
    this.pruneContinuousPlans(now);
    const refreshMs = Math.max(700, Math.min(1500, Math.round(plan.durationMs * 0.7)));
    const lastSentAt = this.lastContinuousPlanAt.get(key);
    if (lastSentAt !== undefined && now - lastSentAt < refreshMs) {
      return true;
    }

    this.lastContinuousPlanAt.set(key, now);
    return false;
  }

  /**
   * Requests that die without a terminal event would otherwise leave their
   * throttle entry behind forever.
   */
  private pruneContinuousPlans(now: number): void {
    const cutoff = now - CONTINUOUS_PLAN_TTL_MS;
    for (const [key, lastSentAt] of this.lastContinuousPlanAt) {
      if (lastSentAt < cutoff) {
        this.lastContinuousPlanAt.delete(key);
      }
    }
  }

  private clearContinuousPlans(requestId: string | undefined): void {
    if (!requestId) {
      this.lastContinuousPlanAt.clear();
      return;
    }

    const prefix = `${requestId}:`;
    for (const key of this.lastContinuousPlanAt.keys()) {
      if (key.startsWith(prefix)) {
        this.lastContinuousPlanAt.delete(key);
      }
    }
  }

  private record(
    event: CoyoteEvent,
    input: Parameters<ShockPlanStore["add"]>[0]["input"],
    output: Parameters<ShockPlanStore["add"]>[0]["output"],
    outcome: Parameters<ShockPlanStore["add"]>[0]["outcome"],
    error?: string
  ): void {
    this.planStore?.add({
      timestamp: Date.now(),
      eventType: event.type,
      requestId: event.requestId,
      model: event.model,
      input,
      output,
      outcome,
      error,
      safety: this.safety.getStatus()
    });
  }
}
