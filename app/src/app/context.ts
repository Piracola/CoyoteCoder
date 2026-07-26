import type { AppConfig } from "../config/schema.js";
import type { DglabController } from "../dglab/controller.js";
import type { WaveformRegistry } from "../dglab/waves.js";
import type { EventBus } from "../events/bus.js";
import type { ShockPlanStore } from "../shock/planStore.js";
import type { ShockPolicy } from "../shock/policy.js";
import type { SafetyGate } from "../shock/safety.js";
import type { ShockPlan } from "../shock/types.js";

export interface CoyoteAppContext {
  config: AppConfig;
  bus: EventBus;
  safety: SafetyGate;
  policy: ShockPolicy;
  dglab?: DglabController;
  shockPlans?: ShockPlanStore;
  waveforms?: WaveformRegistry;
  /**
   * Directly recalls queued pulses and zeroes both channels. Panic uses this
   * rather than relying on an event round-trip through the shock engine.
   * Resolves to whether a zero actually reached the device.
   */
  emergencyZero?: () => Promise<boolean>;
  /**
   * Feeds a plan through the same serialized send chain the engine uses, so a
   * console test cannot interleave its clear/setStrength/pulse triplet with an
   * in-flight one.
   */
  sendPlan?: (plan: ShockPlan) => Promise<void>;
}
