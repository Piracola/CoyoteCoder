import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../app/context.js";
import { registerUiRuntimeRoutes } from "./ui/runtimeRoutes.js";
import { registerUiSettingsRoutes } from "./ui/settingsRoutes.js";
import { registerUiStateRoutes } from "./ui/stateRoutes.js";
import { registerUiStaticRoutes } from "./ui/staticRoutes.js";
import { registerUiUpstreamRoutes } from "./ui/upstreamRoutes.js";
import { registerUiWaveformRoutes } from "./ui/waveformRoutes.js";

export function registerUiRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  registerUiStaticRoutes(app);
  registerUiStateRoutes(app, context);
  registerUiWaveformRoutes(app, context);
  registerUiRuntimeRoutes(app, context);
  registerUiSettingsRoutes(app, context);
  registerUiUpstreamRoutes(app, context);
}
