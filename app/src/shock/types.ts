import type { Channel } from "../config/schema.js";

export interface ShockPlan {
  kind: "shock.plan" | "shock.zero" | "shock.clear";
  channel?: Channel;
  intensity: number;
  durationMs: number;
  reason: string;
}

export interface ShockSink {
  send(plan: ShockPlan, meta: { dryRun: boolean; armed: boolean }): void | Promise<void>;
}
