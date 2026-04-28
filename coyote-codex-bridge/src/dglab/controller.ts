import { EventEmitter } from "node:events";
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

export class DglabController {
  private ws?: WebSocket;
  private clientId?: string;
  private targetId?: string;
  private lastError?: string;
  private connected = false;
  private strengths?: DglabStatus["strengths"];
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly config: AppConfig["dglab"],
    private readonly bus: EventBus
  ) {}

  async connect(): Promise<DglabStatus> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this.getStatus();
    }

    this.lastError = undefined;
    this.clientId = undefined;
    this.targetId = undefined;
    this.ws = new WebSocket(this.config.socket_url);

    this.ws.on("open", () => {
      this.connected = true;
      this.bus.emit({ type: "dglab.connected", timestamp: Date.now() });
    });
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", () => {
      this.connected = false;
      this.clientId = undefined;
      this.targetId = undefined;
      this.bus.emit({ type: "dglab.disconnected", timestamp: Date.now() });
    });
    this.ws.on("error", (error) => {
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
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
      };
      this.ws?.once("open", onOpen);
      this.ws?.once("error", onError);
    });

    return this.getStatus();
  }

  async disconnect(): Promise<void> {
    if (!this.ws) {
      return;
    }
    await this.zeroAll();
    this.ws.close();
    this.ws = undefined;
    this.connected = false;
    this.clientId = undefined;
    this.targetId = undefined;
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

  async zeroAll(): Promise<void> {
    if (!this.clientId || !this.targetId || !this.isOpen()) {
      return;
    }
    await this.clear("A");
    await this.clear("B");
    await this.setStrength("A", 0);
    await this.setStrength("B", 0);
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
    configured.hostname = this.config.qr_host;
    configured.port = String(this.config.qr_port);
    return configured.toString();
  }
}
