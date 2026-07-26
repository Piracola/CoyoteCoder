import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import WebSocket, { WebSocketServer, type WebSocket as WebSocketClient } from "ws";
import type { AppConfig } from "../config/schema.js";

interface RelayMessage {
  type?: string | number;
  clientId?: string;
  targetId?: string;
  message?: string;
  channel?: string | number;
  strength?: number;
  time?: number;
}

interface RelayClient {
  ws: WebSocketClient;
  lastSeen: number;
  pulseTimers: Set<NodeJS.Timeout>;
}

/** Ceiling on a single pulse request's repeat count, in seconds. */
const MAX_PULSE_SECONDS = 60;

export class DglabRelayServer {
  private server?: WebSocketServer;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly clients = new Map<string, RelayClient>();
  private readonly pairings = new Map<string, string>();
  private readonly reversePairings = new Map<string, string>();

  constructor(private readonly config: AppConfig["dglab"]) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const { port } = parseSocketUrl(this.config.socket_url);
    const server = new WebSocketServer({ port, host: this.config.relay_bind_host });
    this.server = server;

    server.on("connection", (socket, request) => this.register(socket, request.socket.remoteAddress));

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 60000);
    this.heartbeatTimer.unref();
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.cancelAllPulses();
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    this.pairings.clear();
    this.reversePairings.clear();

    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Cancels every queued pulse forward. Panic and shutdown depend on this:
   * without it, already-scheduled forwards keep firing after the stop.
   */
  cancelAllPulses(): void {
    for (const client of this.clients.values()) {
      for (const timer of client.pulseTimers) {
        clearTimeout(timer);
      }
      client.pulseTimers.clear();
    }
  }

  private register(ws: WebSocketClient, remoteAddress: string | undefined): void {
    if (!this.config.relay_allow_public && !isPrivateAddress(remoteAddress)) {
      console.warn(JSON.stringify({ kind: "dglab.relay_rejected", reason: "non_private_origin", remoteAddress }));
      ws.close(1008, "origin not allowed");
      return;
    }

    if (this.clients.size >= this.config.relay_max_clients) {
      console.warn(JSON.stringify({ kind: "dglab.relay_rejected", reason: "too_many_clients", remoteAddress }));
      ws.close(1013, "too many clients");
      return;
    }

    const clientId = randomUUID();
    this.clients.set(clientId, { ws, lastSeen: Date.now(), pulseTimers: new Set() });
    this.send(ws, { type: "bind", clientId, targetId: "", message: "targetId" });

    // Any inbound frame counts as liveness, including heartbeat replies that
    // do not carry a full envelope.
    const touch = () => {
      const client = this.clients.get(clientId);
      if (client) {
        client.lastSeen = Date.now();
      }
    };

    ws.on("message", (data) => {
      touch();
      this.handleMessage(ws, data.toString());
    });
    ws.on("pong", touch);
    ws.on("close", () => this.disconnect(clientId));
    ws.on("error", () => this.disconnect(clientId));
  }

  private handleMessage(ws: WebSocketClient, rawMessage: string): void {
    const data = parseMessage(rawMessage);
    if (!data?.type || !data.clientId || !data.targetId || !data.message) {
      this.send(ws, { type: "msg", clientId: "", targetId: "", message: "404" });
      return;
    }

    const senderId = this.findSenderId(ws, data);
    if (!senderId) {
      this.send(ws, { type: "msg", clientId: "", targetId: "", message: "404" });
      return;
    }

    const sender = this.clients.get(senderId);
    if (sender) {
      sender.lastSeen = Date.now();
    }

    if (data.type === "bind") {
      this.handleBind(ws, data);
      return;
    }

    if (!this.isPaired(data.clientId, data.targetId)) {
      this.send(ws, { type: "error", clientId: data.clientId, targetId: data.targetId, message: "402" });
      return;
    }

    if (data.type === "clientMsg") {
      this.handlePulse(ws, data);
      return;
    }

    if (data.type === 1 || data.type === 2 || data.type === 3 || data.type === "1" || data.type === "2" || data.type === "3") {
      this.forwardToTarget(data, `strength-${data.channel ?? 1}+${Number(data.type) - 1}+${Number(data.type) >= 3 ? data.strength ?? 0 : 1}`);
      return;
    }

    if (data.type === 4 || data.type === "4") {
      this.forwardToTarget(data, data.message);
      return;
    }

    this.forwardToClient(data);
  }

  private handleBind(ws: WebSocketClient, data: RelayMessage): void {
    const clientId = data.clientId!;
    const targetId = data.targetId!;
    if (!this.clients.has(clientId) || !this.clients.has(targetId)) {
      this.send(ws, { type: "bind", clientId, targetId, message: "401" });
      return;
    }

    if (this.pairings.has(clientId) || this.reversePairings.has(targetId)) {
      this.send(ws, { type: "bind", clientId, targetId, message: "400" });
      return;
    }

    this.pairings.set(clientId, targetId);
    this.reversePairings.set(targetId, clientId);
    const message = { type: "bind", clientId, targetId, message: "200" };
    this.send(ws, message);
    const webClient = this.clients.get(clientId);
    if (webClient?.ws !== ws) {
      this.send(webClient?.ws, message);
    }
  }

  private handlePulse(ws: WebSocketClient, data: RelayMessage): void {
    if (!data.channel) {
      this.send(ws, { type: "error", clientId: data.clientId!, targetId: data.targetId!, message: "406-channel is empty" });
      return;
    }

    const senderId = this.findSenderId(ws, data);
    const sender = senderId ? this.clients.get(senderId) : undefined;
    if (!sender) {
      // Without a sender the timers could not be tracked, and an untracked
      // timer is one that panic cannot recall.
      this.send(ws, { type: "error", clientId: data.clientId!, targetId: data.targetId!, message: "404" });
      return;
    }

    // `time` arrives from a paired LAN peer. Unbounded, it would let one
    // message allocate an arbitrary number of timers and stall the event loop,
    // taking every stop path down with it.
    const requested = Number(data.time ?? 1);
    const seconds = Number.isFinite(requested)
      ? Math.min(MAX_PULSE_SECONDS, Math.max(1, Math.ceil(requested)))
      : 1;
    const intervalMs = 1000;

    // The first forward goes out immediately; the rest are tracked so panic,
    // unbind and shutdown can recall them.
    this.forwardToTarget(data, `pulse-${data.message}`);
    for (let index = 1; index < seconds; index += 1) {
      const timer = setTimeout(() => {
        sender.pulseTimers.delete(timer);
        this.forwardToTarget(data, `pulse-${data.message}`);
      }, index * intervalMs);
      timer.unref?.();
      sender.pulseTimers.add(timer);
    }
  }

  private cancelPulsesFor(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    for (const timer of client.pulseTimers) {
      clearTimeout(timer);
    }
    client.pulseTimers.clear();
  }

  private forwardToTarget(data: RelayMessage, message: string): void {
    this.send(this.clients.get(data.targetId!)?.ws, {
      type: "msg",
      clientId: data.clientId!,
      targetId: data.targetId!,
      message
    });
  }

  private forwardToClient(data: RelayMessage): void {
    this.send(this.clients.get(data.clientId!)?.ws, {
      type: data.type!,
      clientId: data.clientId!,
      targetId: data.targetId!,
      message: data.message!
    });
  }

  private disconnect(clientId: string): void {
    this.cancelPulsesFor(clientId);
    const pairedId = this.pairings.get(clientId) ?? this.reversePairings.get(clientId);
    if (pairedId) {
      this.cancelPulsesFor(pairedId);
      const message = { type: "break", clientId, targetId: pairedId, message: "209" };
      this.send(this.clients.get(pairedId)?.ws, message);
      this.pairings.delete(clientId);
      this.reversePairings.delete(clientId);
      this.pairings.delete(pairedId);
      this.reversePairings.delete(pairedId);
    }
    this.clients.delete(clientId);
  }

  private isPaired(clientId: string, targetId: string): boolean {
    return this.pairings.get(clientId) === targetId || this.reversePairings.get(clientId) === targetId;
  }

  private findSenderId(ws: WebSocketClient, data: RelayMessage): string | undefined {
    if (data.clientId && this.clients.get(data.clientId)?.ws === ws) {
      return data.clientId;
    }
    if (data.targetId && this.clients.get(data.targetId)?.ws === ws) {
      return data.targetId;
    }
    return undefined;
  }

  private send(ws: WebSocketClient | undefined, message: RelayMessage): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendHeartbeat(): void {
    const now = Date.now();
    for (const [clientId, client] of this.clients) {
      if (now - client.lastSeen > 300000) {
        client.ws.close();
        this.disconnect(clientId);
        continue;
      }
      this.send(client.ws, { type: "heartbeat", clientId, targetId: this.pairings.get(clientId) ?? this.reversePairings.get(clientId) ?? "", message: "200" });
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }
}

function isPrivateAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  // ::ffff:192.168.1.5 style mapped addresses arrive on dual-stack sockets.
  const normalized = address.replace(/^::ffff:/i, "").toLowerCase();

  if (normalized === "::1" || normalized === "127.0.0.1" || normalized === "localhost") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return true;
  }
  if (/^10(?:\.\d{1,3}){3}$/.test(normalized)) {
    return true;
  }
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(normalized)) {
    return true;
  }
  const class172 = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(normalized);
  if (class172 && Number(class172[1]) >= 16 && Number(class172[1]) <= 31) {
    return true;
  }
  // Link-local IPv4 plus IPv6 unique-local and link-local ranges.
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(normalized)) {
    return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe80:/.test(normalized)) {
    return true;
  }
  return false;
}

export async function startLocalDglabRelay(config: AppConfig["dglab"]): Promise<DglabRelayServer | undefined> {
  if (!shouldStartLocalRelay(config.socket_url)) {
    return undefined;
  }

  const relay = new DglabRelayServer(config);
  try {
    await relay.start();
    return relay;
  } catch (error) {
    if (isAddressInUse(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseMessage(rawMessage: string): RelayMessage | undefined {
  try {
    const parsed = JSON.parse(rawMessage) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RelayMessage) : undefined;
  } catch {
    return undefined;
  }
}

function parseSocketUrl(socketUrl: string): { port: number; hostname: string; protocol: string } {
  const url = new URL(socketUrl);
  return {
    port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
    hostname: url.hostname,
    protocol: url.protocol
  };
}

function shouldStartLocalRelay(socketUrl: string): boolean {
  const { hostname, protocol } = parseSocketUrl(socketUrl);
  return protocol === "ws:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}
