import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../../app/context.js";
import { buildUiState, buildWaveformState, getWaveformCatalog } from "./state.js";

export function registerUiWaveformRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.get("/ui/waveforms", async () => buildWaveformState(await getWaveformCatalog(context)));
  app.post("/ui/waveforms/refresh", async () => {
    await context.waveforms?.getCatalog(true);
    return buildUiState(context);
  });
}
