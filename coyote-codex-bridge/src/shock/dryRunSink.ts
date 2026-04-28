import type { ShockSink, ShockPlan } from "./types.js";

export class DryRunSink implements ShockSink {
  send(plan: ShockPlan, meta: { dryRun: boolean; armed: boolean }): void {
    const payload = {
      ...plan,
      mode: meta.dryRun ? "dry-run" : "blocked-no-device",
      armed: meta.armed
    };
    console.log(JSON.stringify(payload));
  }
}
