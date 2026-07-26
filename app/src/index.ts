import { createCoyoteRuntime } from "./app/runtime.js";

const runtime = await createCoyoteRuntime();
const { app, context } = runtime;
const { config } = context;

let shuttingDown = false;

const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`received ${signal}, zeroing output and shutting down`);
  // close() panics the gate, drains queued sends and zeroes the device before
  // the transports go away.
  await runtime.close();
  process.exit(exitCode);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
// Windows console close / Ctrl+Break.
process.once("SIGHUP", () => void shutdown("SIGHUP"));
process.once("SIGBREAK", () => void shutdown("SIGBREAK"));

// A crash must not leave the device energised.
process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
  void shutdown("unhandledRejection", 1);
});

await app.listen({
  host: config.server.host,
  port: config.server.port
});
