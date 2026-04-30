import type { FastifyInstance } from "fastify";
import type { CoyoteAppContext } from "../../app/context.js";
import { writeConfigPatch } from "../../config/configFile.js";
import { configSchema } from "../../config/schema.js";
import {
  makeProviderId,
  parseJsonBody,
  readNumber,
  readObject,
  readOptionalString,
  readProtocol,
  readString
} from "./body.js";
import { buildUiState, toPersistedUpstream } from "./state.js";

export function registerUiUpstreamRoutes(app: FastifyInstance, context: CoyoteAppContext): void {
  app.post("/ui/upstream", async (request) => {
    const body = parseJsonBody(request.body);
    const action = readString(body, "action");
    const upstream = readObject(body, "upstream") ?? body;
    const providerId = readString(upstream, "id") ?? readString(body, "id");
    let providers = [...context.config.upstream.providers];
    let activeProvider = context.config.upstream.active_provider;

    if (action === "select") {
      if (!providerId || !providers.some((provider) => provider.id === providerId)) {
        throw new Error("unknown_provider");
      }
      activeProvider = providerId;
    } else if (action === "delete") {
      if (!providerId || !providers.some((provider) => provider.id === providerId)) {
        throw new Error("unknown_provider");
      }
      if (providers.length <= 1) {
        throw new Error("last_provider_cannot_be_deleted");
      }
      providers = providers.filter((provider) => provider.id !== providerId);
      if (activeProvider === providerId) {
        activeProvider = providers[0].id;
      }
    } else {
      const id = providerId ?? makeProviderId(readString(upstream, "name") ?? "custom");
      const existing = providers.find((provider) => provider.id === id);
      const provider = {
        ...existing,
        id,
        name: readString(upstream, "name") ?? existing?.name ?? "Custom API",
        protocol: readProtocol(upstream, "protocol") ?? existing?.protocol ?? "openai",
        base_url: readString(upstream, "baseUrl") ?? readString(upstream, "base_url") ?? existing?.base_url ?? "https://api.openai.com",
        api_key:
          upstream.apiKey === undefined && upstream.api_key === undefined
            ? existing?.api_key
            : readOptionalString(upstream, "apiKey") ?? readOptionalString(upstream, "api_key"),
        anthropic_version:
          readString(upstream, "anthropicVersion") ??
          readString(upstream, "anthropic_version") ??
          existing?.anthropic_version ??
          "2023-06-01",
        timeout_ms: readNumber(upstream, "timeoutMs") ?? readNumber(upstream, "timeout_ms") ?? existing?.timeout_ms ?? 120000
      };
      providers = existing ? providers.map((item) => (item.id === id ? provider : item)) : [...providers, provider];
      activeProvider = id;
    }

    const nextConfig = configSchema.parse({
      ...context.config,
      upstream: {
        ...context.config.upstream,
        active_provider: activeProvider,
        providers
      }
    });

    Object.assign(context.config.upstream, nextConfig.upstream);
    writeConfigPatch({ upstream: toPersistedUpstream(nextConfig.upstream) });
    return buildUiState(context);
  });
}
