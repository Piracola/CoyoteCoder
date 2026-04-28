import type { ShockSink, ShockPlan } from "../shock/types.js";
import type { DglabController } from "./controller.js";
import { softPulseWave } from "./waves.js";

export class DglabSink implements ShockSink {
  constructor(private readonly controller: DglabController) {}

  async send(plan: ShockPlan, meta: { dryRun: boolean; armed: boolean }): Promise<void> {
    if (meta.dryRun || !meta.armed) {
      console.log(JSON.stringify({ ...plan, mode: meta.dryRun ? "dry-run" : "blocked-unarmed", armed: meta.armed }));
      return;
    }

    if (plan.kind === "shock.zero") {
      await this.controller.zeroAll();
      return;
    }

    if (!plan.channel) {
      return;
    }

    if (plan.kind === "shock.clear") {
      await this.controller.clear(plan.channel);
      return;
    }

    const strength = Math.round(plan.intensity * 100);
    await this.controller.clear(plan.channel);
    await this.controller.setStrength(plan.channel, strength);
    await this.controller.pulse(plan.channel, softPulseWave, plan.durationMs);
  }
}
