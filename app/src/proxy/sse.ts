export interface SseEvent {
  data: string;
}

export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  feed(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drainCompleteEvents();
  }

  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drainCompleteEvents();
    if (this.buffer.trim().length > 0) {
      events.push(this.parseBlock(this.buffer));
    }
    this.buffer = "";
    return events;
  }

  private drainCompleteEvents(): SseEvent[] {
    const events: SseEvent[] = [];
    while (true) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }
      const end = match.index;
      const sepLength = match[0].length;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + sepLength);
      events.push(this.parseBlock(block));
    }
    return events;
  }

  private parseBlock(block: string): SseEvent {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return { data };
  }
}
