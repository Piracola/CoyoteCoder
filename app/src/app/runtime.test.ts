import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { configSchema } from "../config/schema.js";
import { createCoyoteRuntime, type CoyoteRuntime } from "./runtime.js";

let runtime: CoyoteRuntime | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) {
    socket.close();
  }
  sockets.length = 0;
  await runtime?.close();
  runtime = undefined;
});

/**
 * Stands in for the DG-LAB app: binds to the controller through the built-in
 * relay and records every command the device would have received.
 */
async function pairMockApp(runtimeInstance: CoyoteRuntime, socketUrl: string): Promise<string[]> {
  const dglab = runtimeInstance.context.dglab;
  if (!dglab) {
    throw new Error("dglab controller missing");
  }

  await dglab.connect();
  const controllerId = await dglab.waitForClientId();

  const app = new WebSocket(socketUrl);
  sockets.push(app);
  const firstMessage = JSON.parse((await once(app, "message"))[0].toString()) as { clientId: string };
  app.send(
    JSON.stringify({ type: "bind", clientId: controllerId, targetId: firstMessage.clientId, message: "targetId" })
  );

  const received: string[] = [];
  app.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as { message?: string };
    if (parsed.message) {
      received.push(parsed.message);
    }
  });

  await waitUntil(() => dglab.getStatus().bound);
  return received;
}

describe("runtime shutdown", () => {
  it("zeroes both channels before tearing down", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      server: { port: await getFreePort() },
      safety: { dry_run: false, armed: true, panic_zero_on_exit: true },
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${port}`, qr_host: "127.0.0.1", qr_port: port }
    });

    runtime = await createCoyoteRuntime(config);
    const received = await pairMockApp(runtime, config.dglab.socket_url);

    await runtime.context.dglab?.setStrength("A", 35);
    await waitUntil(() => received.some((message) => message.includes("+35")));

    const instance = runtime;
    runtime = undefined;
    await instance.close();

    // Both channels must be commanded to zero; the old shutdown path left the
    // device running at whatever strength it had latched.
    await waitUntil(() => received.filter((message) => /strength-\d\+2\+0$/.test(message)).length >= 2, 3000);
    expect(received.filter((message) => /strength-\d\+2\+0$/.test(message)).length).toBeGreaterThanOrEqual(2);
  });

  it("disarms when the DG-LAB link drops", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      server: { port: await getFreePort() },
      safety: { dry_run: false, armed: false },
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${port}`, qr_host: "127.0.0.1", qr_port: port }
    });

    runtime = await createCoyoteRuntime(config);
    await pairMockApp(runtime, config.dglab.socket_url);

    runtime.context.safety.arm();
    expect(runtime.context.safety.getStatus().armed).toBe(true);

    // Closing the app end produces a break, which must not leave an armed
    // session pointing at a dead link.
    sockets[0]?.close();

    await waitUntil(() => !runtime?.context.safety.getStatus().armed, 3000);
    expect(runtime.context.safety.getStatus().armed).toBe(false);
  });

  it("keeps emergencyZero available without shutting down", async () => {
    const port = await getFreePort();
    const config = configSchema.parse({
      server: { port: await getFreePort() },
      safety: { dry_run: false, armed: true },
      dglab: { enabled: true, socket_url: `ws://127.0.0.1:${port}`, qr_host: "127.0.0.1", qr_port: port }
    });

    runtime = await createCoyoteRuntime(config);
    const received = await pairMockApp(runtime, config.dglab.socket_url);

    await runtime.emergencyZero();

    await waitUntil(() => received.filter((message) => /strength-\d\+2\+0$/.test(message)).length >= 2, 2000);
    expect(runtime.context.dglab?.getStatus().bound).toBe(true);
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
