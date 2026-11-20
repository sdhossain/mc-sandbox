import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CaseDefinitionSchema, type CaseDefinition } from "../../src/cases/case-definition.ts";
import { olderScoringCount, type LoggedTrial } from "../../src/cases/trial-log.ts";
import { TrialRescorer } from "../../src/cases/trial-rescorer.ts";
import { captureBaseline, writeBaseline, type RegionBaseline } from "../../src/mcserver/region-baseline.ts";
import type { BlockState, Box } from "../../src/minecraft/types.ts";

const AIR: BlockState = { name: "air", properties: {} };
const anchor = { x: 0, y: 64, z: 0 };
/** The case's area: x -3..3, y 63..66, z 0. */
const area: Box = { min: { x: -3, y: 63, z: 0 }, max: { x: 3, y: 66, z: 0 } };
/** Grass ground at y 63, one step of grass at (2, 64, 0), and the plank to copy at (-2, 64, 0). */
const START: Record<string, string> = {
  "-3,63,0": "grass_block",
  "-2,63,0": "grass_block",
  "-1,63,0": "grass_block",
  "0,63,0": "grass_block",
  "1,63,0": "grass_block",
  "2,63,0": "grass_block",
  "3,63,0": "grass_block",
  "2,64,0": "grass_block",
  "-2,64,0": "oak_planks",
};
/** Copy x -3..-1 at y 64 three blocks east, onto x 0..2: air, the plank, air (where the grass step is). */
const copyCheck = { copy: { from: [-3, 0, 0], to: [-1, 0, 0], offset: [3, 0, 0] } };
const inventoryCheck = { inventory: { item: "oak_planks", min: 1 } };

function definition(fields: Record<string, unknown>): CaseDefinition {
  return CaseDefinitionSchema.parse({
    id: "copy-plank",
    title: "t",
    category: "t",
    hypothesis: "t",
    prompt: "t",
    scene: "existing",
    anchor: [0, 64, 0],
    reset: { from: [-3, -1, 0], to: [3, 2, 0] },
    ...fields,
  });
}

/** The area with the given non-air blocks. */
function areaWith(blocks: Record<string, string>, source: string): RegionBaseline {
  return captureBaseline(
    area,
    (position) => {
      const name = blocks[`${position.x},${position.y},${position.z}`];
      return name === undefined ? AIR : { name, properties: {} };
    },
    source,
  );
}

function trial(stateFile: string | null, checks: LoggedTrial["checks"]): LoggedTrial {
  return {
    caseId: "copy-plank",
    trial: 1,
    model: "m",
    harness: "skills",
    gameMode: "survival",
    runId: "r",
    anchor,
    startedAt: "2026-11-20T00:00:00Z",
    passed: false,
    checks,
    answersQuestions: true,
    autoReplies: [],
    status: "completed",
    steps: 1,
    toolCalls: 1,
    toolErrors: 0,
    costUsd: 0,
    durationMs: 1000,
    finalText: "done",
    stateId: "t1",
    stateFile,
    checkpoint: null,
  };
}

describe("trial rescorer", () => {
  const directory = mkdtempSync(join(tmpdir(), "mclab-rescore-"));
  const start = areaWith(START, "start");
  const startPath = join(directory, "start.json.gz");
  writeBaseline(startPath, start);
  /** Saves an end state and returns its file. */
  const saveEnd = (name: string, blocks: Record<string, string>): string => {
    const path = join(directory, `${name}.json.gz`);
    writeBaseline(path, areaWith(blocks, name));
    return path;
  };

  it("scores a trial again from its saved end state, not counting untouched ground", () => {
    const end = saveEnd("copied", { ...START, "1,64,0": "oak_planks" });
    const logged = trial(end, [{ label: "copy", passed: false, detail: "1 extra" }]);
    const rescored = new TrialRescorer(definition({ checks: [copyCheck] }), start).rescore(logged);
    expect(rescored.passed).toBe(true);
    expect(rescored.checks[0]?.metrics).toMatchObject({ blocksRight: 1, extraBlocks: 0, groundCells: 1 });
  });

  it("still counts a block the bot added where the copy should be empty", () => {
    const end = saveEnd("cluttered", { ...START, "1,64,0": "oak_planks", "0,64,0": "cobblestone" });
    const rescored = new TrialRescorer(definition({ checks: [copyCheck] }), start).rescore(trial(end, []));
    expect(rescored.passed).toBe(false);
    expect(rescored.checks[0]?.metrics).toMatchObject({ extraBlocks: 1, groundCells: 1 });
  });

  it("keeps the logged result of checks that need more than the saved blocks", () => {
    const end = saveEnd("with-inventory", { ...START, "1,64,0": "oak_planks" });
    const logged = trial(end, [
      { label: "copy", passed: false, detail: "1 extra" },
      { label: "holds planks", passed: false, detail: "holds 0" },
    ]);
    const rescored = new TrialRescorer(definition({ checks: [copyCheck, inventoryCheck] }), start).rescore(logged);
    expect(rescored.checks[0]?.passed).toBe(true);
    expect(rescored.checks[1]).toEqual({ label: "holds planks", passed: false, detail: "holds 0" });
    expect(rescored.passed).toBe(false);
  });

  it("returns a trial without a saved end state as logged", () => {
    const logged = trial(null, [{ label: "copy", passed: false, detail: "not scored" }]);
    expect(new TrialRescorer(definition({ checks: [copyCheck] }), start).rescore(logged)).toBe(logged);
  });

  it("counts the trials an older checker scored, which did not report untouched ground", () => {
    const older = trial(null, [{ label: "copy", passed: false, detail: "", metrics: { blocksRight: 1, blocks: 1 } }]);
    const current = trial(null, [
      { label: "copy", passed: true, detail: "", metrics: { blocksRight: 1, blocks: 1, groundCells: 0 } },
    ]);
    const noCopy = trial(null, [{ label: "reply", passed: true, detail: "" }]);
    expect(olderScoringCount([older, current, noCopy, older])).toBe(2);
  });

  it("refuses cases whose start state is not recorded", () => {
    expect(() =>
      TrialRescorer.forCase(definition({ checks: [copyCheck] }), join(directory, "missing.json.gz")),
    ).toThrow(/no recorded start state/);
    expect(() =>
      TrialRescorer.forCase(definition({ checks: [copyCheck], setup: ["setblock ~ ~ ~ stone"] }), startPath),
    ).toThrow(/changes blocks after the reset/);
    expect(TrialRescorer.forCase(definition({ checks: [copyCheck] }), startPath)).toBeInstanceOf(TrialRescorer);
  });
});
