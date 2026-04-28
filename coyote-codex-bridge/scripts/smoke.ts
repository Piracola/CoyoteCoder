import { createServer } from "node:http";
import { once } from "node:events";
import { buildServer } from "../src/proxy/server.js";
import { EventBus } from "../src/events/bus.js";
import { SafetyGate } from "../src/shock/safety.js";
import { ShockPolicy } from "../src/shock/policy.js";
import { DryRunSink } from "../src/shock/dryRunSink.js";
import { ShockEngine } from "../src/shock/engine.js";
import { configSchema } from "../src/config/schema.js";

const upstream = createServer((req, res) => {
  if (req.url === "/v1/chat/completions") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(404).end();
});

upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === "string") {
  throw new Error("mock upstream did not expose a port");
}

const config = configSchema.parse({
  upstream: {
    base_url: `http://127.0.0.1:${upstreamAddress.port}`
  }
});

const bus = new EventBus(config.privacy.recent_event_limit);
const safety = new SafetyGate(config.safety);
const policy = new ShockPolicy(config.policy);
new ShockEngine(bus, policy, safety, new DryRunSink());
const app = buildServer({ config, bus, safety, policy });
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("proxy did not expose a port");
}

const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock-agent-model", stream: true, messages: [] })
});

const text = await response.text();
if (!text.includes("[DONE]")) {
  throw new Error("SSE passthrough failed");
}

const types = bus.getRecent().map((event) => event.type);
for (const expected of ["request.started", "request.body_seen", "response.started", "response.chunk", "response.done"]) {
  if (!types.includes(expected as typeof types[number])) {
    throw new Error(`missing event: ${expected}`);
  }
}

await app.close();
upstream.close();
console.log("smoke ok");
