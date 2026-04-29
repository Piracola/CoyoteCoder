import { describe, expect, it } from "vitest";
import { configSchema } from "./schema.js";

describe("config schema", () => {
  it("enables DG-LAB pairing by default", () => {
    const config = configSchema.parse({});

    expect(config.dglab).toMatchObject({
      enabled: true,
      socket_url: "ws://127.0.0.1:9999",
      qr_host: "auto",
      qr_port: 9999
    });
    expect(config.upstream).toMatchObject({
      active_provider: "openai",
      base_url: "https://api.openai.com"
    });
    expect(config.safety).toMatchObject({
      dry_run: true,
      armed: false
    });
  });

  it("rejects non-local bind hosts", () => {
    expect(() => configSchema.parse({ server: { host: "0.0.0.0" } })).toThrow();
  });
});
