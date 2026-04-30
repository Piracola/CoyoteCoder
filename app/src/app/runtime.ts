import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/schema.js";
import { DglabController } from "../dglab/controller.js";
import { startLocalDglabRelay, type DglabRelayServer } from "../dglab/relay.js";
import { DglabSink } from "../dglab/sink.js";
import { WaveformRegistry } from "../dglab/waves.js";
import { EventBus } from "../events/bus.js";
import { buildServer } from "../proxy/server.js";
import { DryRunSink } from "../shock/dryRunSink.js";
import { ShockEngine } from "../shock/engine.js";
import { ShockPlanStore } from "../shock/planStore.js";
import { ShockPolicy } from "../shock/policy.js";
import { SafetyGate } from "../shock/safety.js";
import type { CoyoteAppContext } from "./context.js";

export interface CoyoteRuntime {
  app: FastifyInstance;
  context: CoyoteAppContext;
  close: () => Promise<void>;
}

export async function createCoyoteRuntime(config: AppConfig = loadConfig()): Promise<CoyoteRuntime> {
  const bus = new EventBus(config.privacy.recent_event_limit);
  const safety = new SafetyGate(config.safety);
  const policy = new ShockPolicy(config.policy);
  const waveforms = new WaveformRegistry();
  const dglabRelay = config.dglab.enabled ? await startLocalDglabRelay(config.dglab) : undefined;
  const dglab = config.dglab.enabled ? new DglabController(config.dglab, bus) : undefined;
  const sink = dglab ? new DglabSink(dglab, waveforms) : new DryRunSink();
  const shockPlans = new ShockPlanStore(config.privacy.recent_event_limit);

  const context: CoyoteAppContext = {
    config,
    bus,
    safety,
    policy,
    dglab,
    shockPlans,
    waveforms
  };

  new ShockEngine(bus, policy, safety, sink, shockPlans);

  const app = buildServer(context);

  return {
    app,
    context,
    close: () => closeRuntime(app, dglabRelay)
  };
}

async function closeRuntime(app: FastifyInstance, dglabRelay: DglabRelayServer | undefined): Promise<void> {
  await dglabRelay?.close();
  await app.close();
}
