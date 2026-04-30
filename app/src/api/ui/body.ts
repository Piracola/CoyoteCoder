import type { Channel, UpstreamProtocol } from "../../config/schema.js";

export function parseJsonBody(body: unknown): Record<string, unknown> {
  if (!body) {
    return {};
  }
  if (Buffer.isBuffer(body)) {
    if (body.byteLength === 0) {
      return {};
    }
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(body) ? body : {};
}

export function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  return typeof source[key] === "boolean" ? source[key] : undefined;
}

export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function readWaveformId(source: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    return undefined;
  }
  const value = source[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value.trim() || null : undefined;
}

export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  return typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] : undefined;
}

export function readProtocol(source: Record<string, unknown>, key: string): UpstreamProtocol | undefined {
  const value = source[key];
  return value === "openai" || value === "anthropic" || value === "gemini" ? value : undefined;
}

export function readChannel(source: Record<string, unknown>, key: string): Channel | undefined {
  return source[key] === "A" || source[key] === "B" ? source[key] : undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function makeProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "custom"}-${Date.now().toString(36)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
