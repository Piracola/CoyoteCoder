import type { FastifyInstance, FastifyReply } from "fastify";
import type { DglabController } from "../dglab/controller.js";

export function registerDglabRoutes(app: FastifyInstance, controller?: DglabController): void {
  app.get("/dglab/status", async () => ({
    ok: true,
    dglab: controller?.getStatus() ?? { enabled: false, connected: false, bound: false }
  }));

  app.post("/dglab/connect", async (_request, reply) => {
    if (!controller) {
      return { ok: false, error: "dglab_disabled" };
    }
    try {
      const status = await controller.connect();
      return { ok: true, dglab: status };
    } catch (error) {
      return dglabUnavailable(reply, controller, error);
    }
  });

  app.post("/dglab/disconnect", async () => {
    if (!controller) {
      return { ok: true, dglab: { enabled: false, connected: false, bound: false } };
    }
    await controller.disconnect();
    return { ok: true, dglab: controller.getStatus() };
  });

  app.get("/dglab/qr", async (_request, reply) => {
    if (!controller) {
      return { ok: false, error: "dglab_disabled" };
    }
    try {
      await controller.connect();
      await controller.waitForClientId();
      return { ok: true, qrLink: controller.getStatus().qrLink, dglab: controller.getStatus() };
    } catch (error) {
      return dglabUnavailable(reply, controller, error);
    }
  });
}

function dglabUnavailable(reply: FastifyReply, controller: DglabController, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  reply.code(503);
  return {
    ok: false,
    error: friendlyDglabError(message),
    dglab: controller.getStatus()
  };
}

function friendlyDglabError(message: string): string {
  if (message.includes("ECONNREFUSED")) {
    return "DG-LAB Socket 未启动或端口不可用";
  }
  if (message.includes("timed out waiting for DG-LAB clientId")) {
    return "DG-LAB Socket 已连接，但没有返回配对码";
  }
  return message || "DG-LAB Socket 连接失败";
}
