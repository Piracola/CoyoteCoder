import type { FastifyInstance } from "fastify";
import type { DglabController } from "../dglab/controller.js";

export function registerDglabRoutes(app: FastifyInstance, controller?: DglabController): void {
  app.get("/dglab/status", async () => ({
    ok: true,
    dglab: controller?.getStatus() ?? { enabled: false, connected: false, bound: false }
  }));

  app.post("/dglab/connect", async () => {
    if (!controller) {
      return { ok: false, error: "dglab_disabled" };
    }
    const status = await controller.connect();
    return { ok: true, dglab: status };
  });

  app.post("/dglab/disconnect", async () => {
    if (!controller) {
      return { ok: true, dglab: { enabled: false, connected: false, bound: false } };
    }
    await controller.disconnect();
    return { ok: true, dglab: controller.getStatus() };
  });

  app.get("/dglab/qr", async () => {
    if (!controller) {
      return { ok: false, error: "dglab_disabled" };
    }
    await controller.connect();
    await controller.waitForClientId();
    return { ok: true, qrLink: controller.getStatus().qrLink, dglab: controller.getStatus() };
  });
}
