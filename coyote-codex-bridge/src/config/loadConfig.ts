import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { configSchema, type AppConfig } from "./schema.js";

export function loadConfig(): AppConfig {
  const configPath = resolve(process.cwd(), process.env.COYOTE_CONFIG ?? "config.yaml");
  const rawConfig = existsSync(configPath)
    ? YAML.parse(readFileSync(configPath, "utf8")) ?? {}
    : {};

  const withEnv = {
    ...rawConfig,
    server: {
      ...rawConfig.server,
      host: process.env.HOST ?? rawConfig.server?.host,
      port: process.env.PORT ?? rawConfig.server?.port
    },
    upstream: {
      ...rawConfig.upstream,
      name: process.env.UPSTREAM_NAME ?? rawConfig.upstream?.name,
      protocol: process.env.UPSTREAM_PROTOCOL ?? rawConfig.upstream?.protocol,
      base_url: process.env.UPSTREAM_BASE_URL ?? rawConfig.upstream?.base_url,
      api_key_env: process.env.UPSTREAM_API_KEY_ENV ?? rawConfig.upstream?.api_key_env,
      api_key: process.env.UPSTREAM_API_KEY ?? rawConfig.upstream?.api_key,
      anthropic_version: process.env.ANTHROPIC_VERSION ?? rawConfig.upstream?.anthropic_version,
      timeout_ms: process.env.UPSTREAM_TIMEOUT_MS ?? rawConfig.upstream?.timeout_ms
    }
  };

  return configSchema.parse(withEnv);
}
