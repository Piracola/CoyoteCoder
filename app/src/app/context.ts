import type { AppConfig } from "../config/schema.js";
import type { DglabController } from "../dglab/controller.js";
import type { WaveformRegistry } from "../dglab/waves.js";
import type { EventBus } from "../events/bus.js";
import type { ShockPlanStore } from "../shock/planStore.js";
import type { ShockPolicy } from "../shock/policy.js";
import type { SafetyGate } from "../shock/safety.js";

export interface CoyoteAppContext {
  config: AppConfig;
  bus: EventBus;
  safety: SafetyGate;
  policy: ShockPolicy;
  dglab?: DglabController;
  shockPlans?: ShockPlanStore;
  waveforms?: WaveformRegistry;
}
