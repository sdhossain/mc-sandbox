import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LiveRegions, RestoreReport } from "../mcserver/live-regions.ts";
import { readBaseline, writeBaseline } from "../mcserver/region-baseline.ts";
import { LabError } from "../utils/errors.ts";
import { formatDuration } from "../utils/text.ts";
import { caseAreaBox } from "./case-definition.ts";
import type { CaseLibrary } from "./case-library.ts";
import { firstMetrics, TrialLog, verdictOf, type LoggedTrial } from "./trial-log.ts";
import type { TrialRecord } from "./trial-runner.ts";

/** Records boxes of the live world and puts them back: {@link LiveRegions} in the lab. */
export type AreaRecorder = Pick<LiveRegions, "capture" | "restore">;

/** A trial's end state, in its run directory. */
const STATE_FILE = "case-area.after.json.gz";
/** A chat reply lists at most this many states, newest first, so that it fits. */
const CHAT_LIST_LIMIT = 8;
const STATE_ID = /^t(\d+)$/;

/**
 * The end state of every trial, kept so the owner can put it back into the live world and look at it.
 *
 * After a trial, {@link save} records the case's area as the agent left it, in the trial's run
 * directory, and the trial log gives the state a short id (`t1`, `t2`, ...). {@link load} puts a state
 * back by that id; given a case id instead, it puts back the case's recorded start state.
 */
export class TrialStates {
  readonly #runsDir: string;
  readonly #cases: CaseLibrary;
  readonly #regions: AreaRecorder;

  /**
   * @param runsDir - The lab's runs directory, which holds the trial logs and run directories.
   * @param cases - The cases the trials ran, for their areas and start states.
   * @param regions - Reads and restores areas of the live world.
   */
  constructor(runsDir: string, cases: CaseLibrary, regions: AreaRecorder) {
    this.#runsDir = runsDir;
    this.#cases = cases;
    this.#regions = regions;
  }

  /**
   * Records the area of the trial's case as the trial left it.
   *
   * @returns The file the state was written to.
   * @throws LabError when the case never started, or the area cannot be read (for example without RCON).
   */
  async save(record: TrialRecord): Promise<string> {
    if (record.anchor === null) {
      throw new LabError(`Trial ${record.trial} never started case ${record.caseId}, so there is no area to save.`);
    }
    const box = caseAreaBox(this.#cases.get(record.caseId), record.anchor);
    const state = await this.#regions.capture(box, `end of trial ${record.trial}, run ${record.runId}`);
    const file = join(this.#runsDir, record.runId, STATE_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeBaseline(file, state);
    return file;
  }

  /** Every trial whose end state was saved, by id (`t1` first). */
  list(): LoggedTrial[] {
    return TrialLog.all(this.#runsDir)
      .filter((trial) => trial.stateFile !== null)
      .sort((a, b) => stateNumber(a.stateId) - stateNumber(b.stateId));
  }

  /**
   * Puts a saved state into the world: only the cells that differ change.
   *
   * @param id - A trial's state id (`t7`), or a case id for that case's recorded start state.
   * @returns What was loaded, in one line.
   * @throws LabError when there is no such state, or the area cannot be restored.
   */
  async load(id: string): Promise<string> {
    // State ids and case ids are both lower case; accept `T7` too.
    const key = id.trim().toLowerCase();
    if (STATE_ID.test(key)) {
      return this.#loadTrial(key);
    }
    if (this.#cases.has(key)) {
      return this.#loadCaseStart(key);
    }
    throw new LabError(`There is no saved state "${id}". ${this.describeRecent()}`);
  }

  /** The newest saved states in one line, for a chat reply. */
  describeRecent(): string {
    const states = this.list();
    if (states.length === 0) {
      return "No trial states are saved yet; trials save one each (npm run lab -- trials <case>).";
    }
    const newest = states.slice(-CHAT_LIST_LIMIT).reverse();
    const older = states.length - newest.length;
    return `Saved states, newest first: ${newest.map(shortDescription).join("; ")}${older > 0 ? `; ${older} older` : ""}. Load one with !load <id>.`;
  }

  async #loadTrial(id: string): Promise<string> {
    const trial = TrialLog.all(this.#runsDir).find((candidate) => candidate.stateId === id);
    if (trial === undefined) {
      throw new LabError(`There is no saved state ${id}. ${this.describeRecent()}`);
    }
    if (trial.stateFile === null || !existsSync(trial.stateFile)) {
      throw new LabError(`The end state of ${describeState(trial)} was not saved.`);
    }
    const report = await this.#regions.restore(readBaseline(trial.stateFile));
    return `Loaded ${describeState(trial)} (${describeRestore(report)}).`;
  }

  async #loadCaseStart(id: string): Promise<string> {
    const path = this.#cases.baselinePath(id);
    if (!existsSync(path)) {
      throw new LabError(`Case ${id} has no recorded start state; "!case ${id}" builds its scene.`);
    }
    const report = await this.#regions.restore(readBaseline(path));
    return `Loaded the start state of case ${id} (${describeRestore(report)}).`;
  }
}

/** `t7: mirror-hut, gpt-6.2-sol trial 3, FAIL: 288/295 blocks right, 7 extra`. */
export function describeState(trial: LoggedTrial): string {
  return `${trial.stateId}: ${trial.caseId}, ${trial.model} trial ${trial.trial}, ${verdictOf(trial)}`;
}

/** `t7 gpt-6.2-sol #3 FAIL 288/295`, for lists in chat. */
function shortDescription(trial: LoggedTrial): string {
  const metrics = firstMetrics(trial);
  const score =
    metrics?.blocksRight === undefined || metrics.blocks === undefined
      ? `${trial.checks.filter((check) => check.passed).length}/${trial.checks.length} checks`
      : `${metrics.blocksRight}/${metrics.blocks}`;
  return `${trial.stateId} ${trial.model} #${trial.trial} ${trial.passed ? "PASS" : "FAIL"} ${score}`;
}

function describeRestore(report: RestoreReport): string {
  return report.commands === 0
    ? "it was already in place"
    : `${report.commands} commands in ${formatDuration(report.durationMs)}`;
}

function stateNumber(id: string): number {
  return Number(STATE_ID.exec(id)?.[1] ?? 0);
}
