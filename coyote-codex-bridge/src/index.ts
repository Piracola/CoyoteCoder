import { loadConfig } from "./config/loadConfig.js";
import { DglabController } from "./dglab/controller.js";
import { DglabSink } from "./dglab/sink.js";
import { EventBus } from "./events/bus.js";
import { buildServer } from "./proxy/server.js";
import { DryRunSink } from "./shock/dryRunSink.js";
import { ShockEngine } from "./shock/engine.js";
import { ShockPlanStore } from "./shock/planStore.js";
import { ShockPolicy } from "./shock/policy.js";
import { SafetyGate } from "./shock/safety.js";

const config = loadConfig();
const bus = new EventBus(config.privacy.recent_event_limit);
const safety = new SafetyGate(config.safety);
const policy = new ShockPolicy(config.policy);
const dglab = config.dglab.enabled ? new DglabController(config.dglab, bus) : undefined;
const sink = dglab ? new DglabSink(dglab) : new DryRunSink();
const shockPlans = new ShockPlanStore(config.privacy.recent_event_limit);
new ShockEngine(bus, policy, safety, sink, shockPlans);

const app = buildServer({ config, bus, safety, policy, dglab, shockPlans });

if (config.safety.panic_zero_on_exit) {
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, sending best-effort panic zero`);
    safety.panic();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

await app.listen({
  host: config.server.host,
  port: config.server.port
});
