import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

export function registerUiStaticRoutes(app: FastifyInstance): void {
  const legacyUiRoot = join(process.cwd(), "src", "ui");
  const builtUiRoot = join(process.cwd(), "src-ui", "dist");
  const sourceUiPublicRoot = join(process.cwd(), "src-ui", "public");

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  app.get("/ui", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  app.get("/ui/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return readUiIndex(builtUiRoot, legacyUiRoot);
  });

  const serveBuiltPublicAsset = async (assetName: string, reply: FastifyReply) => {
    if (assetName !== "icon.png") {
      reply.code(404);
      return { ok: false, error: "asset_not_found" };
    }
    const builtFile = join(builtUiRoot, assetName);
    const file = (await fileExists(builtFile)) ? builtFile : join(sourceUiPublicRoot, assetName);
    reply.type(contentTypeFor(file));
    return readFile(file);
  };

  const serveBuiltAsset = async (assetPath: string, reply: FastifyReply) => {
    if (!assetPath || assetPath.includes("..")) {
      reply.code(400);
      return { ok: false, error: "invalid_asset_path" };
    }
    const file = join(builtUiRoot, "assets", assetPath);
    reply.type(contentTypeFor(file));
    return readFile(file);
  };

  app.get("/icon.png", async (_request, reply) => serveBuiltPublicAsset("icon.png", reply));
  app.get("/ui/icon.png", async (_request, reply) => serveBuiltPublicAsset("icon.png", reply));
  app.get<{ Params: { "*": string } }>("/ui/assets/*", async (request, reply) => serveBuiltAsset(request.params["*"], reply));
  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => serveBuiltAsset(request.params["*"], reply));

  app.get("/ui/app.js", async (_request, reply) => {
    reply.type("application/javascript; charset=utf-8");
    return readFile(join(legacyUiRoot, "app.js"), "utf8");
  });

  app.get("/ui/styles.css", async (_request, reply) => {
    reply.type("text/css; charset=utf-8");
    return readFile(join(legacyUiRoot, "styles.css"), "utf8");
  });
}

async function readUiIndex(builtUiRoot: string, legacyUiRoot: string): Promise<string> {
  const builtIndex = join(builtUiRoot, "index.html");
  if (await fileExists(builtIndex)) {
    return readFile(builtIndex, "utf8");
  }
  return readFile(join(legacyUiRoot, "index.html"), "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
