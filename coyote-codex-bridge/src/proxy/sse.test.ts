import { describe, expect, it } from "vitest";
import { SseParser } from "./sse.js";

const encoder = new TextEncoder();

describe("SseParser", () => {
  it("parses single data events", () => {
    const parser = new SseParser();
    expect(parser.feed(encoder.encode("data: hello\n\n"))).toEqual([{ data: "hello" }]);
  });

  it("joins multiline data events", () => {
    const parser = new SseParser();
    expect(parser.feed(encoder.encode("data: hello\ndata: world\n\n"))).toEqual([{ data: "hello\nworld" }]);
  });

  it("preserves DONE events for callers to interpret", () => {
    const parser = new SseParser();
    expect(parser.feed(encoder.encode("data: [DONE]\n\n"))).toEqual([{ data: "[DONE]" }]);
  });

  it("handles events split across chunk boundaries", () => {
    const parser = new SseParser();
    expect(parser.feed(encoder.encode("data: hel"))).toEqual([]);
    expect(parser.feed(encoder.encode("lo\n\n"))).toEqual([{ data: "hello" }]);
  });
});
