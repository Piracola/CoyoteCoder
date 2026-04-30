import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import type { CoyoteAppContext } from "../../app/context.js";
import type { Channel } from "../../config/schema.js";
import { softPulseWave } from "../../dglab/waves.js";
import type { ShockPlan } from "../../shock/types.js";
import { clamp, clampInteger, parseJsonBody, readChannel, readNumber } from "./body.js";
import { buildUiState } from "./state.js";

const TEST_SHOCK_MIN_INTENSITY = 0.1;
const TEST_SHOCK_DEFAULT_DURATION_MS = 220;

export function registerUiRuntimeRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.post<{ Body: Buffer }>("/ui/start", async () => {
    context.safety.arm();
    context.bus.emit({ type: "safety.armed", timestamp: Date.now() });
    return buildUiState(context);
  });

  app.post("/ui/stop", async () => {
    context.safety.disarm();
    context.bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    if (context.dglab) {
      await context.dglab.disconnect();
    }
    return buildUiState(context);
  });

  app.post("/ui/test-shock", async (request) => {
    const body = parseJsonBody(request.body);
    const result = await sendTestShock(context, {
      channel: readChannel(body, "channel") ?? "A",
      intensity: readNumber(body, "intensity") ?? TEST_SHOCK_MIN_INTENSITY,
      durationMs: readNumber(body, "durationMs") ?? TEST_SHOCK_DEFAULT_DURATION_MS
    });
    return {
      ...(await buildUiState(context)),
      testShock: result
    };
  });

  app.get("/ui/qr.svg", async (_request, reply) => {
    if (!context.dglab) {
      reply.code(404);
      return { ok: false, error: "dglab_disabled" };
    }
    try {
      await context.dglab.connect();
      await context.dglab.waitForClientId();
    } catch (error) {
      reply.code(503);
      return { ok: false, error: friendlyDglabError(error), dglab: context.dglab.getStatus() };
    }
    const qrLink = context.dglab.getStatus().qrLink;
    if (!qrLink) {
      reply.code(503);
      return { ok: false, error: "qr_not_ready" };
    }
    const svg = await QRCode.toString(qrLink, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: {
        dark: "#172033",
        light: "#ffffff"
      }
    });
    reply.type("image/svg+xml; charset=utf-8");
    return svg;
  });
}

function friendlyDglabError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ECONNREFUSED")) {
    return "DG-LAB Socket 未启动或端口不可用";
  }
  if (message.includes("timed out waiting for DG-LAB clientId")) {
    return "DG-LAB Socket 已连接，但没有返回配对码";
  }
  return message || "DG-LAB Socket 连接失败";
}

async function sendTestShock(
  context: CoyoteAppContext,
  input: { channel: Channel; intensity: number; durationMs: number }
): Promise<{ outcome: "sent" | "blocked" | "error"; dryRun: boolean; message: string }> {
  const timestamp = Date.now();
  const status = context.dglab?.getStatus();
  const safety = context.safety.getStatus();
  const plan: ShockPlan = {
    kind: "shock.plan",
    channel: input.channel,
    intensity: clamp(input.intensity, TEST_SHOCK_MIN_INTENSITY, 1),
    durationMs: clampInteger(input.durationMs, 1, 1000),
    reason: "dglab.test"
  };

  context.bus.emit({ type: "dglab.test", timestamp });

  if (!context.dglab || !status?.enabled) {
    recordShockPlan(context, timestamp, plan, undefined, "error", "dglab_disabled");
    return { outcome: "error", dryRun: safety.dryRun, message: "DG-LAB 未启用" };
  }

  if (!status.connected || !status.bound) {
    recordShockPlan(context, timestamp, plan, undefined, "error", "dglab_not_bound");
    return { outcome: "error", dryRun: safety.dryRun, message: "DG-LAB 尚未完成 APP 配对" };
  }

  const safePlan = context.safety.evaluate(plan);
  if (!safePlan) {
    recordShockPlan(context, timestamp, plan, undefined, "blocked");
    return { outcome: "blocked", dryRun: safety.dryRun, message: "测试电击被安全限制拦截" };
  }

  if (safety.dryRun) {
    recordShockPlan(context, timestamp, plan, safePlan, "sent");
    return { outcome: "sent", dryRun: true, message: "Dry-run 已记录，未发送真实输出" };
  }

  if (!safePlan.channel) {
    recordShockPlan(context, timestamp, plan, safePlan, "blocked", "missing_channel");
    return { outcome: "blocked", dryRun: false, message: "测试电击缺少通道，已拦截" };
  }

  try {
    await context.dglab.clear(safePlan.channel);
    await context.dglab.setStrength(safePlan.channel, Math.round(safePlan.intensity * 100));
    await context.dglab.pulse(safePlan.channel, softPulseWave, safePlan.durationMs);
    recordShockPlan(context, timestamp, plan, safePlan, "sent");
    return { outcome: "sent", dryRun: false, message: "测试电击已发送" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordShockPlan(context, timestamp, plan, safePlan, "error", message);
    return { outcome: "error", dryRun: false, message };
  }
}

function recordShockPlan(
  context: CoyoteAppContext,
  timestamp: number,
  input: ShockPlan,
  output: ShockPlan | undefined,
  outcome: "sent" | "blocked" | "error",
  error?: string
): void {
  context.shockPlans?.add({
    timestamp,
    eventType: "dglab.test",
    input,
    output,
    outcome,
    error,
    safety: context.safety.getStatus()
  });
}
