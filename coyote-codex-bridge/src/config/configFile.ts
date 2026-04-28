import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";

export function getConfigPath(): string {
  return resolve(process.cwd(), process.env.COYOTE_CONFIG ?? "config.yaml");
}

export function configFileExists(): boolean {
  return existsSync(getConfigPath());
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

  writeConfigFile(next);
}

export function writeConfigFile(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, YAML.stringify(stripUndefined(config)), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)])
  );
}
