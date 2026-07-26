import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../app/context.js";

export function registerControlRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  const { bus, safety } = context;

  app.post("/control/arm", async () => {
    safety.arm();
    bus.emit({ type: "safety.armed", timestamp: Date.now() });
    return { ok: true, safety: safety.getStatus() };
  });

  app.post("/control/disarm", async () => {
    safety.disarm();
    bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    // Disarming only blocks future plans; the device keeps whatever strength
    // it last latched until something zeroes it.
    const zeroed = await zeroQuietly(context);
    return { ok: true, zeroed, safety: safety.getStatus() };
  });

  app.post("/control/panic", async () => {
    const plans = safety.panic();
    bus.emit({ type: "safety.panic", timestamp: Date.now() });
    // Zero directly rather than waiting for the event to travel through the
    // shock engine: panic must not depend on that path being healthy.
    const zeroed = await zeroQuietly(context);
    return { ok: true, zeroed, plans, safety: safety.getStatus() };
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
    if (dryRun) {
      await zeroQuietly(context);
    }
    return { ok: true, safety: safety.getStatus() };
  });
}

/**
 * Reports whether a zero actually reached the device. A panic button that
 * falsely confirms is worse than one that admits it could not reach anything,
 * so an unbound or disconnected controller must report false.
 */
async function zeroQuietly(context: CoyoteAppContext): Promise<boolean> {
  if (!context.emergencyZero) {
    return false;
  }
  try {
    return await context.emergencyZero();
  } catch (error) {
    console.error(JSON.stringify({ kind: "control.zero_failed", message: String(error) }));
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
