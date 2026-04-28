import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { configSchema } from "../config/schema.js";
import { EventBus } from "../events/bus.js";
import { DglabController } from "./controller.js";

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (server) {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function createMockSocketServer(onConnection: (socket: WebSocket) => void): Promise<string> {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", onConnection);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing websocket server port");
  return `ws://127.0.0.1:${address.port}`;
}

describe("DglabController", () => {
  it("connects, receives clientId, tracks binding, and sends commands", async () => {
    const received: unknown[] = [];
    const socketUrl = await createMockSocketServer((socket) => {
      socket.send(JSON.stringify({ type: "bind", clientId: "client-1", targetId: "", message: "targetId" }));
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
      setTimeout(() => {
        socket.send(JSON.stringify({ type: "bind", clientId: "client-1", targetId: "app-1", message: "200" }));
      }, 10);
    });

    const config = configSchema.parse({
      dglab: {
        enabled: true,
        socket_url: socketUrl,
        qr_host: "127.0.0.1"
      }
    });
    const bus = new EventBus(20);
    const controller = new DglabController(config.dglab, bus);

    await controller.connect();
    await controller.waitForClientId();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(controller.getStatus()).toMatchObject({
      connected: true,
      bound: true,
      clientId: "client-1",
      targetId: "app-1"
    });
    expect(controller.getStatus().qrLink).toContain("#DGLAB-SOCKET#");

    await controller.clear("A");
    await controller.setStrength("B", 12);
    await waitUntil(() => received.length === 2);

    expect(received).toEqual([
      { type: 4, clientId: "client-1", targetId: "app-1", message: "clear-1" },
      { type: 3, clientId: "client-1", targetId: "app-1", channel: 2, strength: 12, message: "set channel" }
    ]);
    expect(bus.getRecent().map((event) => event.type)).toContain("dglab.bound");

    await controller.disconnect();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
