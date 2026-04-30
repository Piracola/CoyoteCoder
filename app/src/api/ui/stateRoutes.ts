import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../../app/context.js";
import { buildUiState } from "./state.js";

export function registerUiStateRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.get("/ui/state", async () => buildUiState(context));
}
