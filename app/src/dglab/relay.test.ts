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
