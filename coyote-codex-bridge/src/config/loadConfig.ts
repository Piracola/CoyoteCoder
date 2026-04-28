import { configSchema, type AppConfig } from "./schema.js";
import { readConfigFile } from "./configFile.js";

export function loadConfig(): AppConfig {
  const rawConfig = readConfigFile() as Record<string, any>;

  const withEnv = {
    ...rawConfig,
    server: {
      ...rawConfig.server,
      host: process.env.HOST ?? rawConfig.server?.host,
      port: process.env.PORT ?? rawConfig.server?.port
    },
    dglab: {
      ...rawConfig.dglab,
      enabled: readEnvBoolean("DGLAB_ENABLED") ?? rawConfig.dglab?.enabled,
      socket_url: process.env.DGLAB_SOCKET_URL ?? rawConfig.dglab?.socket_url,
      qr_host: process.env.DGLAB_QR_HOST ?? rawConfig.dglab?.qr_host,
      qr_port: process.env.DGLAB_QR_PORT ?? rawConfig.dglab?.qr_port
    }
  };

  return configSchema.parse(withEnv);
}

function readEnvBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return undefined;
}
