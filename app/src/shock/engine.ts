import type { EventBus } from "../events/bus.js";
import type { CoyoteEvent } from "../events/types.js";
import type { ShockPlanStore } from "./planStore.js";
import { ShockPolicy } from "./policy.js";
import { SafetyGate } from "./safety.js";
import type { ShockSink } from "./types.js";

export class ShockEngine {
  private readonly lastContinuousPlanAt = new Map<string, number>();

  constructor(
    bus: EventBus,
    private readonly policy: ShockPolicy,
    private readonly safety: SafetyGate,
    private readonly sink: ShockSink,
    private readonly planStore?: ShockPlanStore
  ) {
    bus.onEvent((event) => {
      void this.handle(event);
    });
  }

  async emitPlansFor(event: CoyoteEvent): Promise<void> {
    await this.handle(event);
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
      }
    }

    if (event.type === "response.done" || event.type === "response.error" || event.type === "response.aborted") {
      this.clearContinuousPlans(event.requestId);
    }
  }

  private shouldSkipContinuousPlan(event: CoyoteEvent, plan: Parameters<ShockPlanStore["add"]>[0]["input"]): boolean {
    if (!plan.continuous || !plan.channel) {
      return false;
    }

    const key = `${event.requestId ?? "global"}:${plan.channel}`;
    const now = event.timestamp || Date.now();
    const refreshMs = Math.max(700, Math.min(1500, Math.round(plan.durationMs * 0.7)));
    const lastSentAt = this.lastContinuousPlanAt.get(key);
    if (lastSentAt !== undefined && now - lastSentAt < refreshMs) {
      return true;
    }

    this.lastContinuousPlanAt.set(key, now);
    return false;
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
