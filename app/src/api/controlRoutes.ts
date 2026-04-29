import type { FastifyInstance } from "fastify";
import type { EventBus } from "../events/bus.js";
import type { SafetyGate } from "../shock/safety.js";

export function registerControlRoutes(app: FastifyInstance, bus: EventBus, safety: SafetyGate): void {
  app.post("/control/arm", async () => {
    safety.arm();
    bus.emit({ type: "safety.armed", timestamp: Date.now() });
    return { ok: true, safety: safety.getStatus() };
  });

  app.post("/control/disarm", async () => {
    safety.disarm();
    bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    return { ok: true, safety: safety.getStatus() };
  });

  app.post("/control/panic", async () => {
    const plans = safety.panic();
    bus.emit({ type: "safety.panic", timestamp: Date.now() });
    return { ok: true, plans, safety: safety.getStatus() };
  });

  app.post("/control/dry-run", async (request) => {
    let dryRun = true;
    if (Buffer.isBuffer(request.body) && request.body.byteLength > 0) {
      const parsed = JSON.parse(request.body.toString("utf8")) as { enabled?: unknown };
      dryRun = parsed.enabled !== false;
    } else if (isRecord(request.body)) {
      dryRun = request.body.enabled !== false;
    }
    safety.setDryRun(dryRun);
    return { ok: true, safety: safety.getStatus() };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
