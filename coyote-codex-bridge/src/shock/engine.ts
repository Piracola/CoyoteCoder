import type { EventBus } from "../events/bus.js";
import type { CoyoteEvent } from "../events/types.js";
import { ShockPolicy } from "./policy.js";
import { SafetyGate } from "./safety.js";
import type { ShockSink } from "./types.js";

export class ShockEngine {
  constructor(
    bus: EventBus,
    private readonly policy: ShockPolicy,
    private readonly safety: SafetyGate,
    private readonly sink: ShockSink
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
      if (safePlan) {
        try {
          await this.sink.send(safePlan, this.safety.getStatus());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ kind: "shock.error", reason: safePlan.reason, message }));
        }
      }
    }
  }
}
