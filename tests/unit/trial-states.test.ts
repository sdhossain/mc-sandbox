import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { caseAreaBox, CaseDefinitionSchema, type CaseDefinition } from "../../src/cases/case-definition.ts";
import { CaseLibrary } from "../../src/cases/case-library.ts";
import { countTrials, TrialLog, verdictOf, type LoggedTrial } from "../../src/cases/trial-log.ts";
import { TrialStates, type AreaRecorder } from "../../src/cases/trial-states.ts";
import type { RestoreReport } from "../../src/mcserver/live-regions.ts";
import {
  captureBaseline,
  readBaseline,
  writeBaseline,
  type RegionBaseline,
} from "../../src/mcserver/region-baseline.ts";
import type { BlockState, Box } from "../../src/minecraft/types.ts";

const stone: BlockState = { name: "stone", properties: {} };
const anchor = { x: 10, y: 64, z: 10 };

function definition(fields: Record<string, unknown>): CaseDefinition {
  return CaseDefinitionSchema.parse({ title: "t", category: "t", hypothesis: "t", prompt: "t", ...fields });
}

/** A case set in one place that resets a 5x5x5 box, and one that flattens a site around the owner. */
const hut = definition({
  id: "hut",
  scene: "existing",
  anchor: [10, 64, 10],
  reset: { from: [-2, -1, -2], to: [2, 3, 2] },
});
const flat = definition({ id: "flat", site: { radius: 3, height: 4 } });

/** Records the world as all stone, and remembers what it was asked to restore. */
class FakeRegions implements AreaRecorder {
  readonly restored: RegionBaseline[] = [];

  capture(box: Box, source: string): Promise<RegionBaseline> {
    return Promise.resolve(captureBaseline(box, () => stone, source));
  }

  restore(baseline: RegionBaseline): Promise<RestoreReport> {
    this.restored.push(baseline);
    return Promise.resolve({ commands: 3, durationMs: 40 });
  }
}

function trial(fields: Partial<LoggedTrial>): LoggedTrial {
  return {
    caseId: "hut",
    trial: 1,
    model: "gpt-x",
    harness: "skills",
    gameMode: "survival",
    runId: "run-1",
    anchor,
    startedAt: "2026-11-20T00:00:00.000Z",
    passed: false,
    checks: [{ label: "copy", passed: false, detail: "", metrics: { blocksRight: 288, blocks: 295, extraBlocks: 7 } }],
    answersQuestions: true,
    autoReplies: [],
    status: "completed",
    steps: 10,
    toolCalls: 9,
    toolErrors: 0,
    costUsd: 0.5,
    durationMs: 60_000,
    finalText: "done",
    stateId: "t1",
    stateFile: null,
    checkpoint: null,
    ...fields,
  };
}

describe("trial states", () => {
  let runsDir: string;
  let caseDir: string;
  let regions: FakeRegions;
  let states: TrialStates;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "mclab-runs-"));
    caseDir = mkdtempSync(join(tmpdir(), "mclab-cases-"));
    regions = new FakeRegions();
    states = new TrialStates(runsDir, new CaseLibrary([hut, flat], caseDir), regions);
  });

  it("gives state ids one after another across every case's log", () => {
    expect(TrialLog.nextStateId(runsDir)).toBe("t1");
    new TrialLog(runsDir, "hut").append(trial({ stateId: "t1" }));
    new TrialLog(runsDir, "flat").append(trial({ caseId: "flat", stateId: "t2" }));
    expect(TrialLog.nextStateId(runsDir)).toBe("t3");
    new TrialLog(runsDir, "hut", "trials-code-commands").append(trial({ stateId: "t3" }));
    expect(TrialLog.nextStateId(runsDir)).toBe("t4");
    expect(TrialLog.all(runsDir).map((logged) => logged.stateId)).toEqual(["t2", "t1", "t3"]);
    expect(() => new TrialLog(runsDir, "hut", "elsewhere")).toThrow(/must be named "trials"/);
  });

  it("rewrites a log after copying it aside, and the copy is never read as a log", () => {
    const log = new TrialLog(runsDir, "hut");
    log.append(trial({ stateId: "t1" }));
    log.append(trial({ stateId: "t2" }));
    const first = log.read();
    log.rewrite(
      first.map((logged) => ({
        ...logged,
        passed: true,
        asLogged: { passed: false, checks: logged.checks, rescoredAt: "now" },
      })),
      "before-rescore-test",
    );
    expect(log.read().map((logged) => [logged.stateId, logged.passed, logged.asLogged?.passed])).toEqual([
      ["t1", true, false],
      ["t2", true, false],
    ]);
    expect(readFileSync(`${log.jsonlPath}.before-rescore-test`, "utf8")).toContain('"passed":false');
    expect(
      readFileSync(log.csvPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(",true,")).length,
    ).toBe(2);
    expect(TrialLog.all(runsDir).map((logged) => logged.stateId)).toEqual(["t1", "t2"]);
  });

  it("counts the trials logged under the same conditions", () => {
    const conditions = { model: "gpt-x", harness: "skills", gameMode: "survival", answersQuestions: true };
    const records = [
      trial({}),
      trial({ stateId: "t2" }),
      trial({ stateId: "t3", harness: "code-commands" }),
      trial({ stateId: "t4", answersQuestions: false }),
    ];
    expect(countTrials(records, conditions)).toBe(2);
    expect(countTrials(records, { ...conditions, harness: "code-commands" })).toBe(1);
  });

  it("covers a case's reset box, or a flattened site with its ground", () => {
    expect(caseAreaBox(hut, anchor)).toEqual({ min: { x: 8, y: 63, z: 8 }, max: { x: 12, y: 67, z: 12 } });
    expect(caseAreaBox(flat, anchor)).toEqual({ min: { x: 7, y: 60, z: 7 }, max: { x: 13, y: 68, z: 13 } });
  });

  it("saves the case's area as a trial left it, and loads it back by its id", async () => {
    const record = trial({ runId: "run-7", trial: 3 });
    const file = await states.save(record);
    expect(file).toBe(join(runsDir, "run-7", "case-area.after.json.gz"));
    expect(readBaseline(file).box).toEqual(caseAreaBox(hut, anchor));
    new TrialLog(runsDir, "hut").append({ ...record, stateId: "t1", stateFile: file });

    await expect(states.load("t1")).resolves.toBe(
      "Loaded t1: hut, gpt-x trial 3, FAIL: 288/295 blocks right, 7 extra (3 commands in 0.0 s).",
    );
    expect(regions.restored).toEqual([readBaseline(file)]);
  });

  it("refuses to save a trial whose case never started", async () => {
    await expect(states.save(trial({ anchor: null }))).rejects.toThrow(/never started case hut/);
  });

  it("loads a case's recorded start state by the case's id", async () => {
    const start = captureBaseline(caseAreaBox(hut, anchor), () => stone, "checkpoint x");
    writeBaseline(join(caseDir, "hut.baseline.json.gz"), start);
    await expect(states.load("hut")).resolves.toMatch(/^Loaded the start state of case hut/);
    expect(regions.restored).toEqual([start]);
    await expect(states.load("flat")).rejects.toThrow(/Case flat has no recorded start state/);
  });

  it("explains unknown ids, and lists the newest states for chat", async () => {
    expect(states.describeRecent()).toMatch(/^No trial states are saved yet/);
    const log = new TrialLog(runsDir, "hut");
    for (let n = 1; n <= 10; n += 1) {
      const runId = `run-${n}`;
      const file = await states.save(trial({ runId, trial: n }));
      log.append(trial({ runId, trial: n, stateId: `t${n}`, stateFile: file }));
    }
    const recent = states.describeRecent();
    expect(recent).toMatch(/^Saved states, newest first: t10 gpt-x #10 FAIL 288\/295; t9 gpt-x #9/);
    expect(recent).toContain("t3 gpt-x #3 FAIL 288/295; 2 older.");
    expect(recent.length).toBeLessThan(600);
    await expect(states.load("t11")).rejects.toThrow(/There is no saved state t11/);
    await expect(states.load("T10")).resolves.toMatch(/^Loaded t10: hut, gpt-x trial 10/);
    await expect(states.load("house")).rejects.toThrow(/There is no saved state "house"/);
  });

  it("does not list or load a trial whose end state could not be saved", async () => {
    new TrialLog(runsDir, "hut").append(trial({ stateId: "t1", stateFile: null }));
    expect(states.list()).toEqual([]);
    await expect(states.load("t1")).rejects.toThrow(/The end state of t1: hut, gpt-x trial 1, FAIL.* was not saved/);
    expect(existsSync(join(runsDir, "run-1"))).toBe(false);
  });

  it("reads trials logged before auto-replies, and rewrites a CSV with older columns", () => {
    const log = new TrialLog(runsDir, "hut");
    const { answersQuestions: _setting, autoReplies: _replies, ...older } = trial({ stateId: "t1" });
    appendFileSync(log.jsonlPath, `${JSON.stringify(older)}\n`);
    writeFileSync(log.csvPath, "state_id,case,model\nt1,hut,gpt-x\n");
    log.append(trial({ stateId: "t2" }));

    expect(log.read().map((logged) => [logged.stateId, logged.answersQuestions, logged.autoReplies])).toEqual([
      ["t1", false, []],
      ["t2", true, []],
    ]);
    const lines = readFileSync(log.csvPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(",status,answers_questions,auto_replies,steps,");
    expect(lines[1]).toMatch(/^t1,hut,gpt-x,.*,completed,false,0,10,/);
    expect(lines[2]).toMatch(/^t2,hut,gpt-x,.*,completed,true,0,10,/);
  });

  it("states a verdict with block counts for copy checks and check counts otherwise", () => {
    expect(verdictOf(trial({}))).toBe("FAIL: 288/295 blocks right, 7 extra");
    const checks = [
      { label: "a", passed: true, detail: "" },
      { label: "b", passed: true, detail: "" },
    ];
    expect(verdictOf(trial({ passed: true, checks }))).toBe("PASS: 2/2 checks");
  });
});
