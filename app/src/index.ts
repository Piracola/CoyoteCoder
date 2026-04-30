import { createCoyoteRuntime } from "./app/runtime.js";

const runtime = await createCoyoteRuntime();
const { app, context } = runtime;
const { config, safety } = context;

if (config.safety.panic_zero_on_exit) {
  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, sending best-effort panic zero`);
    safety.panic();
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

await app.listen({
  host: config.server.host,
  port: config.server.port
});
