import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export const WAVEFORM_DIRECTORY_NAME = "waveforms";
export const DEFAULT_WAVEFORM_ID = "default";
export const STREAM_WAVEFORM_ID = "stream-continuous";
const MAX_WAVE_SAMPLES = 100;
const WAVE_SAMPLE_MS = 100;
const SUPPORTED_WAVE_EXTENSIONS = new Set([".json", ".txt", ".wave", ".waves", ".js"]);

export const softPulseWave = [
  "0A0A0A0A00000000",
  "0A0A0A0A0A0A0A0A",
  "0A0A0A0A14141414",
  "0A0A0A0A0A0A0A0A",
  "0A0A0A0A00000000"
];

export const continuousPulseWave = Array.from({ length: 10 }, () => "0A0A0A0A64646464");

export type WaveformSource = "builtin" | "file";

export interface DglabWaveform {
  id: string;
  name: string;
  waves: string[];
  source: WaveformSource;
  fileName?: string;
  directory?: string;
}

export interface WaveformLoadError {
  fileName?: string;
  directory?: string;
  message: string;
}

export interface DglabWaveformCatalog {
  directory: string;
  directories: string[];
  waveforms: DglabWaveform[];
  errors: WaveformLoadError[];
}

export class WaveformRegistry {
  private catalog?: DglabWaveformCatalog;
  private loadedAt = 0;

  constructor(
    private readonly options: { directories?: string[]; ttlMs?: number } = {}
  ) {}

  async getCatalog(force = false): Promise<DglabWaveformCatalog> {
    const ttlMs = this.options.ttlMs ?? 2000;
    if (!force && this.catalog && Date.now() - this.loadedAt < ttlMs) {
      return this.catalog;
    }

    this.catalog = await loadDglabWaveforms(this.options.directories);
    this.loadedAt = Date.now();
    return this.catalog;
  }
}

export async function loadDglabWaveforms(directories = defaultWaveformDirectories()): Promise<DglabWaveformCatalog> {
  const uniqueDirectories = [...new Set(directories.map((directory) => resolve(directory)))];
  const waveforms = builtInWaveforms();
  const errors: WaveformLoadError[] = [];
  const usedIds = new Set(waveforms.map((waveform) => waveform.id));
  const existingDirectories: string[] = [];

  for (const directory of uniqueDirectories) {
    const exists = await directoryExists(directory);
    if (!exists) {
      continue;
    }
    existingDirectories.push(directory);

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!SUPPORTED_WAVE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      const path = join(directory, entry.name);
      try {
        const parsed = parseWaveformContent(await readFile(path, "utf8"), entry.name);
        if (parsed.length === 0) {
          errors.push({ directory, fileName: entry.name, message: "未找到 V3 HEX 波形数组" });
          continue;
        }
        for (const item of parsed) {
          const baseId = slugify(`${entry.name}-${item.name}`);
          const id = uniqueId(baseId, usedIds);
          usedIds.add(id);
          waveforms.push({
            id,
            name: item.name,
            waves: item.waves,
            source: "file",
            fileName: entry.name,
            directory
          });
        }
      } catch (error) {
        errors.push({
          directory,
          fileName: entry.name,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return {
    directory: existingDirectories[0] ?? uniqueDirectories[0] ?? resolve(process.cwd(), WAVEFORM_DIRECTORY_NAME),
    directories: uniqueDirectories,
    waveforms,
    errors
  };
}

export function resolveWaveform(
  catalog: DglabWaveformCatalog,
  waveId: string | undefined,
  reason: string
): DglabWaveform {
  const requested = waveId ? catalog.waveforms.find((waveform) => waveform.id === waveId) : undefined;
  if (requested) {
    return requested;
  }

  const defaultId = reason === "response.chunk" ? STREAM_WAVEFORM_ID : DEFAULT_WAVEFORM_ID;
  return (
    catalog.waveforms.find((waveform) => waveform.id === defaultId) ??
    catalog.waveforms.find((waveform) => waveform.id === DEFAULT_WAVEFORM_ID) ??
    builtInWaveforms()[0]
  );
}

export function prepareWaveForPlan(waves: string[], continuous: boolean | undefined, durationMs: number): string[] {
  if (!continuous) {
    const sampleLimit = Math.max(1, Math.ceil(durationMs / WAVE_SAMPLE_MS));
    return waves.slice(0, Math.min(MAX_WAVE_SAMPLES, sampleLimit));
  }

  const minimumSamples = Math.ceil(1000 / WAVE_SAMPLE_MS);
  const prepared: string[] = [];
  while (prepared.length < minimumSamples) {
    prepared.push(...waves);
  }
  return prepared.slice(0, minimumSamples);
}

export function waveformDurationMs(waves: string[]): number {
  return waves.length * WAVE_SAMPLE_MS;
}

function builtInWaveforms(): DglabWaveform[] {
  return [
    {
      id: DEFAULT_WAVEFORM_ID,
      name: "默认柔和脉冲",
      waves: softPulseWave,
      source: "builtin"
    },
    {
      id: STREAM_WAVEFORM_ID,
      name: "流式连续脉冲",
      waves: continuousPulseWave,
      source: "builtin"
    }
  ];
}

function defaultWaveformDirectories(): string[] {
  const configured = process.env.COYOTE_WAVEFORMS_DIR?.trim();
  if (configured) {
    return [configured];
  }

  const cwd = process.cwd();
  return [join(cwd, WAVEFORM_DIRECTORY_NAME), join(cwd, "..", WAVEFORM_DIRECTORY_NAME)];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function parseWaveformContent(content: string, fileName: string): Array<{ name: string; waves: string[] }> {
  const parsed = parseJsonLike(content);
  if (parsed !== undefined) {
    return parseWaveformValue(parsed, fileName);
  }

  const waves = normalizeWaves(content.match(/\b[0-9a-fA-F]{16}\b/g) ?? []);
  return waves.length > 0 ? [{ name: nameFromFile(fileName), waves }] : [];
}

function parseJsonLike(content: string): unknown {
  const normalized = content.trim().replace(/^\uFEFF/, "");
  if (!normalized) {
    return undefined;
  }

  const candidates = [
    normalized,
    normalized.replace(/^export\s+default\s+/u, "").replace(/;$/u, "")
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseWaveformValue(value: unknown, fileName: string): Array<{ name: string; waves: string[] }> {
  if (Array.isArray(value)) {
    const waves = normalizeWaves(value);
    if (waves.length > 0) {
      return [{ name: nameFromFile(fileName), waves }];
    }
    return value.flatMap((item, index) => parseWaveformObject(item, fileName, index));
  }

  return parseWaveformObject(value, fileName, 0);
}

function parseWaveformObject(value: unknown, fileName: string, index: number): Array<{ name: string; waves: string[] }> {
  if (!isRecord(value)) {
    return [];
  }

  const waves = readWaveArray(value);
  if (waves.length === 0) {
    return [];
  }

  return [
    {
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : index === 0 ? nameFromFile(fileName) : `${nameFromFile(fileName)} ${index + 1}`,
      waves
    }
  ];
}

function readWaveArray(value: Record<string, unknown>): string[] {
  for (const key of ["waves", "wave", "data", "expectedV3", "v3", "pulse", "pulses"]) {
    const waves = normalizeWaves(value[key]);
    if (waves.length > 0) {
      return waves;
    }
  }
  return [];
}

function normalizeWaves(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const waves = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[0-9A-F]{16}$/.test(item));

  return waves.slice(0, MAX_WAVE_SAMPLES);
}

function nameFromFile(fileName: string): string {
  return basename(fileName, extname(fileName));
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/u, "")
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "waveform"
  );
}

function uniqueId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    return baseId;
  }
  let index = 2;
  while (usedIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
