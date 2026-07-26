import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import WebSocket from "ws";
import type { AppConfig, Channel } from "../config/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  buildClearMessage,
  buildPulseMessage,
  buildQrLink,
  buildSetStrengthMessage,
  type DglabEnvelope
} from "./protocol.js";

export interface DglabStatus {
  enabled: boolean;
  connected: boolean;
  bound: boolean;
  clientId?: string;
  targetId?: string;
  socketUrl: string;
  qrLink?: string;
  lastError?: string;
  strengths?: {
    A: number;
    B: number;
    softLimitA: number;
    softLimitB: number;
  };
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export class DglabController {
  private ws?: WebSocket;
  private clientId?: string;
  private targetId?: string;
  private lastError?: string;
  private connected = false;
  private strengths?: DglabStatus["strengths"];
  private readonly emitter = new EventEmitter();
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig["dglab"],
    private readonly bus: EventBus
  ) {}

  async connect(): Promise<DglabStatus> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.getStatus();
    }

    this.clearReconnectTimer();
    this.lastError = undefined;
    this.clientId = undefined;
    this.targetId = undefined;

    // Every handler is bound to *this* socket. ws.close() is a handshake, so a
    // superseded socket's close event can arrive after a new one is live;
    // without this guard it would wipe the live connection's clientId/targetId
    // and turn every later zeroAll() into a silent no-op.
    const ws = new WebSocket(this.config.socket_url);
    this.ws = ws;
    const isCurrent = () => this.ws === ws;

    ws.on("open", () => {
      if (!isCurrent()) return;
      this.connected = true;
      this.bus.emit({ type: "dglab.connected", timestamp: Date.now() });
    });
    ws.on("message", (data) => {
      if (!isCurrent()) return;
      this.handleMessage(data);
    });
    ws.on("close", () => {
      if (!isCurrent()) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.clientId = undefined;
      this.targetId = undefined;
      this.strengths = undefined;
      if (wasConnected) {
        // Consumers treat this as "the physical link is gone" and disarm.
        this.bus.emit({ type: "dglab.disconnected", timestamp: Date.now() });
      }
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      if (!isCurrent()) return;
      this.lastError = error.message;
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    // Only count the attempt as successful once the socket is actually usable,
    // so an accept-then-immediately-close server still backs off.
    this.reconnectAttempts = 0;
    this.shouldReconnect = true;
    return this.getStatus();
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    const ws = this.ws;
    if (!ws) {
      return;
    }
    // Best-effort: zero before tearing the socket down, never let a failure
    // here prevent the socket from closing.
    try {
      await this.zeroAll();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    // Detach before closing so the pending close event cannot touch whatever
    // connection comes next.
    this.ws = undefined;
    ws.removeAllListeners();
    ws.close();
    this.connected = false;
    this.clientId = undefined;
    this.targetId = undefined;
    this.strengths = undefined;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.shouldReconnect) {
        return;
      }
      void this.connect().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  getStatus(): DglabStatus {
    return {
      enabled: this.config.enabled,
      connected: this.connected,
      bound: Boolean(this.clientId && this.targetId),
      clientId: this.clientId,
      targetId: this.targetId,
      socketUrl: this.config.socket_url,
      qrLink: this.clientId ? buildQrLink(this.qrSocketUrl(), this.clientId) : undefined,
      lastError: this.lastError,
      strengths: this.strengths
    };
  }

  async setStrength(channel: Channel, strength: number): Promise<void> {
    const { clientId, targetId } = this.requireBound();
    this.send(buildSetStrengthMessage(clientId, targetId, channel, strength));
  }

  async clear(channel: Channel): Promise<void> {
    const { clientId, targetId } = this.requireBound();
    this.send(buildClearMessage(clientId, targetId, channel));
  }

  async pulse(channel: Channel, waves: string[], durationMs: number): Promise<void> {
    const { clientId, targetId } = this.requireBound();
    this.send(buildPulseMessage(clientId, targetId, channel, waves, durationMs / 1000));
  }

  /**
   * Returns false when nothing could be sent (no link, or not bound), so
   * callers can report honestly instead of claiming a zero that never happened.
   */
  async zeroAll(): Promise<boolean> {
    if (!this.clientId || !this.targetId || !this.isOpen()) {
      return false;
    }
    await this.clear("A");
    await this.clear("B");
    await this.setStrength("A", 0);
    await this.setStrength("B", 0);
    // ws.send() only queues; without waiting for the buffer to drain a shutdown
    // can close the socket before the zero actually leaves the process.
    await this.flush();
    return true;
  }

  /** Waits until queued frames have left the socket, or the timeout expires. */
  async flush(timeoutMs = 500): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (ws.bufferedAmount > 0 && Date.now() < deadline && ws.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  waitForClientId(timeoutMs = 5000): Promise<string> {
    if (this.clientId) {
      return Promise.resolve(this.clientId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for DG-LAB clientId"));
      }, timeoutMs);
      const onClientId = (clientId: string) => {
        cleanup();
        resolve(clientId);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off("clientId", onClientId);
      };
      this.emitter.once("clientId", onClientId);
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: Partial<DglabEnvelope>;
    try {
      message = JSON.parse(data.toString()) as Partial<DglabEnvelope>;
    } catch {
      return;
    }

    if (message.type === "bind" && message.clientId && !message.targetId) {
      this.clientId = message.clientId;
      this.emitter.emit("clientId", this.clientId);
      return;
    }

    if (message.type === "bind" && message.message === "200" && message.clientId === this.clientId && message.targetId) {
      this.targetId = message.targetId;
      this.bus.emit({ type: "dglab.bound", timestamp: Date.now() });
      return;
    }

    if (message.type === "break") {
      this.targetId = undefined;
      this.strengths = undefined;
      // Unbinding removes the output path just as surely as a socket drop.
      this.bus.emit({ type: "dglab.disconnected", timestamp: Date.now() });
      return;
    }

    if (message.type === "error") {
      this.lastError = String(message.message ?? "unknown DG-LAB error");
      return;
    }

    if (typeof message.message === "string" && message.message.startsWith("strength-")) {
      const numbers = message.message.match(/\d+/g)?.map(Number);
      if (numbers && numbers.length >= 4) {
        this.strengths = {
          A: numbers[0],
          B: numbers[1],
          softLimitA: numbers[2],
          softLimitB: numbers[3]
        };
        this.bus.emit({ type: "dglab.strength_report", timestamp: Date.now() });
      }
    }

    if (typeof message.message === "string" && message.message.startsWith("feedback-")) {
      this.bus.emit({ type: "dglab.feedback", timestamp: Date.now() });
    }
  }

  private send(message: DglabEnvelope): void {
    if (!this.isOpen()) {
      throw new Error("DG-LAB websocket is not connected");
    }
    this.ws?.send(JSON.stringify(message));
  }

  private requireBound(): { clientId: string; targetId: string } {
    if (!this.clientId || !this.targetId) {
      throw new Error("DG-LAB app is not bound");
    }
    return { clientId: this.clientId, targetId: this.targetId };
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private qrSocketUrl(): string {
    const configured = new URL(this.config.socket_url);
    configured.hostname = this.config.qr_host === "auto" ? inferLanHost() : this.config.qr_host;
    configured.port = String(this.config.qr_port);
    return configured.toString();
  }
}

export interface LanCandidate {
  address: string;
  interfaceName: string;
  /** Higher scores are more likely to be the interface a phone can reach. */
  score: number;
  likelyVirtual: boolean;
}

const VIRTUAL_INTERFACE_HINTS = [
  "vethernet",
  "virtualbox",
  "vmware",
  "hyper-v",
  "docker",
  "wsl",
  "loopback",
  "tailscale",
  "zerotier",
  "tap-windows",
  "openvpn",
  "wireguard",
  "utun",
  "bridge"
];

/**
 * Ranks local IPv4 addresses by how likely a phone on the same Wi-Fi can reach
 * them. Picking the first non-internal address (the old behaviour) routinely
 * selected a WSL, Docker or VPN adapter and produced an unscannable QR code.
 */
export function listLanCandidates(): LanCandidate[] {
  const candidates: LanCandidate[] = [];

  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      const lowerName = interfaceName.toLowerCase();
      const likelyVirtual = VIRTUAL_INTERFACE_HINTS.some((hint) => lowerName.includes(hint));
      let score = 0;

      // Home Wi-Fi and most consumer routers hand out 192.168.x.x.
      if (/^192\.168\./.test(address.address)) {
        score += 40;
      } else if (/^10\./.test(address.address)) {
        score += 25;
      } else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address.address)) {
        score += 20;
      }

      if (/^169\.254\./.test(address.address)) {
        score -= 50;
      }
      if (likelyVirtual) {
        score -= 60;
      }
      if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(lowerName)) {
        score += 15;
      }

      candidates.push({ address: address.address, interfaceName, score, likelyVirtual });
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

function inferLanHost(): string {
  return listLanCandidates()[0]?.address ?? "127.0.0.1";
}
