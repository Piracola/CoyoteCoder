import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WAVEFORM_ID, loadDglabWaveforms, resolveWaveform, STREAM_WAVEFORM_ID } from "./waves.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coyote-waves-"));
  tempDirs.push(dir);
  return dir;
}

describe("DG-LAB waveforms", () => {
  it("loads built-in and file waveforms", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "custom.json"),
      JSON.stringify({
        name: "Custom Tap",
        waves: ["0A0A0A0A64646464", "0A0A0A0A00000000"]
      }),
      "utf8"
    );

    const catalog = await loadDglabWaveforms([dir]);

    expect(catalog.waveforms.map((waveform) => waveform.id)).toEqual(expect.arrayContaining([DEFAULT_WAVEFORM_ID, STREAM_WAVEFORM_ID]));
    expect(catalog.waveforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Custom Tap",
          source: "file",
          waves: ["0A0A0A0A64646464", "0A0A0A0A00000000"]
        })
      ])
    );
  });

  it("uses the continuous built-in waveform for streaming chunks by default", async () => {
    const catalog = await loadDglabWaveforms([]);

    expect(resolveWaveform(catalog, undefined, "response.chunk")).toMatchObject({
      id: STREAM_WAVEFORM_ID
    });
    expect(resolveWaveform(catalog, undefined, "request.started")).toMatchObject({
      id: DEFAULT_WAVEFORM_ID
    });
  });
});
