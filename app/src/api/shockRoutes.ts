import type { FastifyInstance } from "fastify";
import type { ShockPlanStore } from "../shock/planStore.js";

export function registerShockRoutes(app: FastifyInstance, shockPlans?: ShockPlanStore): void {
  app.get("/shock/recent", async (request) => {
    const limit = readLimit(request.query);
    return {
      plans: shockPlans?.getRecent(limit) ?? []
    };
  });
}

function readLimit(query: unknown): number | undefined {
  if (!isRecord(query)) {
    return undefined;
  }
  const value = query.limit;
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(500, Math.max(0, Math.round(parsed))) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
