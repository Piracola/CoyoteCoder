import { EventEmitter } from "node:events";
import type { CoyoteEvent } from "./types.js";

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly recent: CoyoteEvent[] = [];

  constructor(private readonly recentLimit: number) {}

  emit(event: CoyoteEvent): void {
    this.recent.push(event);
    if (this.recent.length > this.recentLimit) {
      this.recent.splice(0, this.recent.length - this.recentLimit);
    }
    this.emitter.emit("event", event);
  }

  onEvent(listener: (event: CoyoteEvent) => void): void {
    this.emitter.on("event", listener);
  }

  getRecent(): CoyoteEvent[] {
    return [...this.recent];
  }
}
