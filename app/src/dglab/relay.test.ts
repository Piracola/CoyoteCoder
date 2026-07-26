import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import { DglabController } from "./controller.js";
import { DglabRelayServer } from "./relay.js";

let relay: DglabRelayServer | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("DglabRelayServer", () => {
  it("allocates ids, pairs app and controller, and routes strength messages", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      dglab: {
        enabled: true,
        socket_url: `ws://127.0.0.1:${port}`,
        qr_host: "127.0.0.1",
        qr_port: port
      }
    });

    relay = new DglabRelayServer(config.dglab);
    await relay.start();

    const controller = new DglabController(config.dglab, new EventBus(20));
    await controller.connect();
    const controllerId = await controller.waitForClientId();

    const app = new WebSocket(config.dglab.socket_url);
    const firstAppMessage = JSON.parse((await once(app, "message"))[0].toString()) as { clientId: string };
    app.send(
      JSON.stringify({
        type: "bind",
        clientId: controllerId,
        targetId: firstAppMessage.clientId,
        message: "targetId"
      })
    );

    await waitUntil(() => controller.getStatus().bound);

    await controller.setStrength("A", 7);
    const appMessage = JSON.parse((await once(app, "message"))[0].toString()) as { message: string };
    expect(appMessage.message).toBe("strength-1+2+7");

    app.close();
    await controller.disconnect();
  });

  it("stops queued pulse forwards when they are cancelled", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${port}`, qr_host: "127.0.0.1", qr_port: port }
    });

    relay = new DglabRelayServer(config.dglab);
    await relay.start();

    const controller = new DglabController(config.dglab, new EventBus(20));
    await controller.connect();
    const controllerId = await controller.waitForClientId();

    const app = new WebSocket(config.dglab.socket_url);
    const firstAppMessage = JSON.parse((await once(app, "message"))[0].toString()) as { clientId: string };
    app.send(
      JSON.stringify({ type: "bind", clientId: controllerId, targetId: firstAppMessage.clientId, message: "targetId" })
    );
    await waitUntil(() => controller.getStatus().bound);

    const forwarded: string[] = [];
    app.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as { message?: string };
      if (parsed.message?.startsWith("pulse-")) {
        forwarded.push(parsed.message);
      }
    });

    // A 4s pulse queues one immediate forward plus three timed ones.
    await controller.pulse("A", ["0A0A0A0A64646464"], 4000);
    await waitUntil(() => forwarded.length >= 1);

    // Panic and shutdown depend on this recalling the rest.
    relay.cancelAllPulses();
    const afterCancel = forwarded.length;
    await new Promise((resolve) => setTimeout(resolve, 2200));

    expect(forwarded.length).toBe(afterCancel);

    app.close();
    await controller.disconnect();
  });

  it("zeroes both channels on disconnect", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${port}`, qr_host: "127.0.0.1", qr_port: port }
    });

    relay = new DglabRelayServer(config.dglab);
    await relay.start();

    const controller = new DglabController(config.dglab, new EventBus(20));
    await controller.connect();
    const controllerId = await controller.waitForClientId();

    const app = new WebSocket(config.dglab.socket_url);
    const firstAppMessage = JSON.parse((await once(app, "message"))[0].toString()) as { clientId: string };
    app.send(
      JSON.stringify({ type: "bind", clientId: controllerId, targetId: firstAppMessage.clientId, message: "targetId" })
    );
    await waitUntil(() => controller.getStatus().bound);

    const received: string[] = [];
    app.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as { message?: string };
      if (parsed.message) {
        received.push(parsed.message);
      }
    });

    await controller.setStrength("A", 40);
    await waitUntil(() => received.some((message) => message.includes("+40")));

    await controller.disconnect();
    await waitUntil(() => received.filter((message) => /strength-\d\+2\+0$/.test(message)).length >= 2, 2000);

    // Both channels must be commanded back to zero before the socket drops.
    expect(received.filter((message) => /strength-\d\+2\+0$/.test(message)).length).toBeGreaterThanOrEqual(2);
    app.close();
  });
});

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
