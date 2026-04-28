import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

export function getConfigPath(): string {
  return resolve(process.cwd(), process.env.COYOTE_CONFIG ?? "config.yaml");
}

export function readConfigFile(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

export function writeConfigPatch(patch: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const next = {
    ...readConfigFile(),
    ...patch
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, YAML.stringify(next), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
