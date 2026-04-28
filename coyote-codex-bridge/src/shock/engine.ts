import type { EventBus } from "../events/bus.js";
import type { CoyoteEvent } from "../events/types.js";
import type { ShockPlanStore } from "./planStore.js";
import { ShockPolicy } from "./policy.js";
import { SafetyGate } from "./safety.js";
import type { ShockSink } from "./types.js";

export class ShockEngine {
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
