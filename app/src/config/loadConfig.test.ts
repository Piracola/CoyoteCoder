import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadConfig } from "./loadConfig.js";

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("creates a default portable config file on first start", () => {
    const dir = mkdtempSync(join(tmpdir(), "coyote-config-"));
    tempDirs.push(dir);
    process.chdir(dir);
    process.env.COYOTE_CONFIG = "config.yaml";

    const config = loadConfig();
    const configPath = join(dir, "config.yaml");
    const persisted = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

    expect(existsSync(configPath)).toBe(true);
    expect(config.safety.dry_run).toBe(true);
    expect(config.safety.armed).toBe(false);
    expect(persisted).toMatchObject({
      server: { host: "127.0.0.1", port: 8787 },
      upstream: { active_provider: "openai" },
      safety: { dry_run: true, armed: false },
      dglab: { socket_url: "ws://127.0.0.1:9999", qr_host: "auto" }
    });
    expect(persisted.upstream).not.toHaveProperty("base_url");
  });
});
