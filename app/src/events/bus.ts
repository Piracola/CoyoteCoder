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

  /** Returns an unsubscribe function so short-lived consumers cannot leak. */
  onEvent(listener: (event: CoyoteEvent) => void): () => void {
    this.emitter.on("event", listener);
    // Console SSE clients plus the engine can exceed the default cap of 10.
    // Re-derived on unsubscribe too, so the leak warning stays useful rather
    // than being permanently disabled by a burst of short-lived subscribers.
    this.syncMaxListeners();
    return () => {
      this.emitter.off("event", listener);
      this.syncMaxListeners();
    };
  }

  private syncMaxListeners(): void {
    this.emitter.setMaxListeners(Math.max(20, this.emitter.listenerCount("event") + 10));
  }

  getRecent(): CoyoteEvent[] {
    return [...this.recent];
  }
}
