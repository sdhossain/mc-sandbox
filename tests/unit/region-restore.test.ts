import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureBaseline, readBaseline, writeBaseline } from "../../src/mcserver/region-baseline.ts";
import { restoreCommands } from "../../src/mcserver/live-regions.ts";
import type { BlockPosition, BlockState } from "../../src/minecraft/types.ts";

const box = { min: { x: 0, y: 64, z: 0 }, max: { x: 3, y: 64, z: 1 } };
const stone: BlockState = { name: "stone", properties: {} };
const air: BlockState = { name: "air", properties: {} };
const stairs: BlockState = {
  name: "oak_stairs",
  properties: { half: "bottom", facing: "east", shape: "straight", waterlogged: "false" },
};

/** A world of `blocks` (keyed "x,y,z"), air elsewhere. */
function worldOf(blocks: Record<string, BlockState>): (position: BlockPosition) => BlockState {
  return (position) => blocks[`${position.x},${position.y},${position.z}`] ?? air;
}

describe("region baselines and restores", () => {
  it("records a box and restores only the cells that differ, as rows where possible", () => {
    // Recorded: a row of 4 stone at z=0, and stairs at (1, 64, 1).
    const recorded = worldOf({ "0,64,0": stone, "1,64,0": stone, "2,64,0": stone, "3,64,0": stone, "1,64,1": stairs });
    const baseline = captureBaseline(box, recorded, "test");
    expect(baseline.cells).toHaveLength(8);

    // Now: three of the stones gone, the stairs turned the wrong way, and a stray block at (3, 64, 1).
    const now = worldOf({
      "0,64,0": stone,
      "1,64,1": { ...stairs, properties: { ...stairs.properties, facing: "west" } },
      "3,64,1": stone,
    });
    expect(restoreCommands(baseline, now)).toEqual([
      "fill 1 64 0 3 64 0 stone strict",
      "setblock 1 64 1 oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] strict",
      "setblock 3 64 1 air strict",
    ]);
    expect(restoreCommands(baseline, recorded)).toEqual([]);
  });

  it("sets cells it cannot read", () => {
    const baseline = captureBaseline(box, worldOf({}), "test");
    expect(restoreCommands(baseline, () => null)).toEqual([
      "fill 0 64 0 3 64 0 air strict",
      "fill 0 64 1 3 64 1 air strict",
    ]);
  });

  it("refuses to record a box that was never generated", () => {
    expect(() => captureBaseline(box, () => null, "test")).toThrow(/never been generated/);
  });

  it("writes and reads baseline files, and rejects broken ones", () => {
    const directory = mkdtempSync(join(tmpdir(), "mclab-baseline-"));
    const path = join(directory, "case.baseline.json.gz");
    const baseline = captureBaseline(box, worldOf({ "1,64,1": stairs }), "checkpoint x");
    writeBaseline(path, baseline);
    expect(readBaseline(path)).toEqual(baseline);
    writeFileSync(path, "not gzip");
    expect(() => readBaseline(path)).toThrow(/Cannot read the baseline/);
  });
});
