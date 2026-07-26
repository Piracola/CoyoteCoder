import type { FastifyInstance, FastifyReply } from "fastify";
import type { CoyoteAppContext } from "../../app/context.js";
import { buildUiState } from "./state.js";

const HEARTBEAT_MS = 20_000;
/** Coalesce bursts so a fast token stream cannot flood the console. */
const STATE_PUSH_INTERVAL_MS = 400;

export function registerUiStateRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.get("/ui/state", async () => buildUiState(context));

  /**
   * Live console feed. Replaces polling so device activity shows up as it
   * happens rather than up to one poll interval late.
   */
  app.get("/ui/stream", async (request, reply) => {
    // Must carry the headers the onRequest hook collected — notably CORS. The
    // packaged desktop app loads from tauri.localhost and talks to 127.0.0.1,
    // so a missing access-control-allow-origin silently kills the live feed
    // there while dev (same-origin via the Vite proxy) looks fine.
    const headers: Record<string, number | string | string[]> = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) {
        headers[key] = value as number | string | string[];
      }
    }
    headers["content-type"] = "text/event-stream; charset=utf-8";
    headers["cache-control"] = "no-cache, no-transform";
    headers.connection = "keep-alive";
    headers["x-accel-buffering"] = "no";

    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.flushHeaders?.();

    let closed = false;
    let pushScheduled = false;
    let pushTimer: NodeJS.Timeout | undefined;

    const write = (event: string, payload: unknown): void => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const pushState = async (): Promise<void> => {
      if (closed) {
        return;
      }
      try {
        write("state", await buildUiState(context));
      } catch (error) {
        write("error", { message: error instanceof Error ? error.message : String(error) });
      }
    };

    const scheduleStatePush = (): void => {
      if (pushScheduled || closed) {
        return;
      }
      pushScheduled = true;
      pushTimer = setTimeout(() => {
        pushScheduled = false;
        pushTimer = undefined;
        void pushState();
      }, STATE_PUSH_INTERVAL_MS);
      pushTimer.unref?.();
    };

    const unsubscribe = context.bus.onEvent((event) => {
      // The event itself goes out immediately for the live log; the heavier
      // full-state snapshot is throttled.
      write("event", event);
      scheduleStatePush();
    });

    const heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      // A bare comment keeps intermediaries from timing the connection out.
      reply.raw.write(": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      if (pushTimer) {
        clearTimeout(pushTimer);
      }
      endQuietly(reply);
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    reply.raw.on("close", cleanup);

    await pushState();
  });
}

function endQuietly(reply: FastifyReply): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.end();
  }
}
