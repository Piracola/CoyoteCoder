import { describe, expect, it } from "vitest";
import {
  buildClearMessage,
  buildPulseMessage,
  buildQrLink,
  buildSetStrengthMessage,
  channelToIndex
} from "./protocol.js";

describe("DG-LAB protocol helpers", () => {
  it("maps channels to Socket V2 indexes", () => {
    expect(channelToIndex("A")).toBe(1);
    expect(channelToIndex("B")).toBe(2);
  });

  it("builds QR links in official format", () => {
    expect(buildQrLink("ws://127.0.0.1:9999/", "abc")).toBe(
      "https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://127.0.0.1:9999/abc"
    );
  });

  it("builds set strength messages", () => {
    expect(buildSetStrengthMessage("client", "target", "B", 500)).toEqual({
      type: 3,
      clientId: "client",
      targetId: "target",
      channel: 2,
      strength: 200,
      message: "set channel"
    });
  });

  it("builds clear and pulse messages", () => {
    expect(buildClearMessage("client", "target", "A")).toMatchObject({ type: 4, message: "clear-1" });
    expect(buildPulseMessage("client", "target", "B", ["0A0A0A0A00000000"], 2)).toMatchObject({
      type: "clientMsg",
      channel: "B",
      time: 2,
      message: 'B:["0A0A0A0A00000000"]'
    });
  });
});
