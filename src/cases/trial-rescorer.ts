import { existsSync } from "node:fs";

import { baselineCells, readBaseline, type RegionBaseline } from "../mcserver/region-baseline.ts";
import type { BlockPosition, BlockState, Box } from "../minecraft/types.ts";
import { LabError } from "../utils/errors.ts";
import {
  baselineBoxOf,
  evaluateCase,
  toBlockMap,
  type Baseline,
  type CaseWorld,
  type CheckResult,
} from "./case-checks.ts";
import type { CaseCheck, CaseDefinition } from "./case-definition.ts";
import type { LoggedTrial } from "./trial-log.ts";

const AIR: BlockState = { name: "air", properties: {} };

/**
 * Scores logged trials again with the current checks, from each trial's saved end state.
 *
 * The case's recorded start state (the baseline of its `reset` box) gives the blocks before the agent
 * started, and the trial's state file the blocks it left. That is all a check needs when it reads only
 * blocks inside the case's area and the final reply (`block`, `count`, `copy`, `unchanged`, `reply`).
 * The other checks keep their logged result. Use it after a change to the checks, to see what the
 * trials logged before the change would score now.
 */
export class TrialRescorer {
  readonly #definition: CaseDefinition;
  readonly #start: RegionBaseline;

  /**
   * @param definition - The case, with its current checks.
   * @param start - The case's start state: the recorded baseline of its `reset` box.
   */
  constructor(definition: CaseDefinition, start: RegionBaseline) {
    this.#definition = definition;
    this.#start = start;
  }

  /**
   * A rescorer for a case whose start state is on disk.
   *
   * @throws LabError when the case has no `reset` box and recorded baseline, or changes blocks after the
   *   reset (`setup` or `damage` commands), so that its start state is not known.
   */
  static forCase(definition: CaseDefinition, baselinePath: string): TrialRescorer {
    if (definition.reset === undefined || !existsSync(baselinePath)) {
      throw new LabError(
        `Case ${definition.id} has no recorded start state (a reset box and its baseline), so its trials cannot be scored again.`,
      );
    }
    if (definition.setup.length > 0 || definition.damage.length > 0) {
      throw new LabError(
        `Case ${definition.id} changes blocks after the reset (setup or damage commands), so its start state is not the recorded baseline and its trials cannot be scored again.`,
      );
    }
    return new TrialRescorer(definition, readBaseline(baselinePath));
  }

  /**
   * The trial scored again: its checks and verdict from its saved end state. A trial whose end state was
   * not saved, or whose logged checks no longer line up with the case's checks, is returned as logged.
   */
  rescore(trial: LoggedTrial): LoggedTrial {
    const checks = this.#definition.checks;
    const { anchor, stateFile } = trial;
    if (anchor === null || stateFile === null || !existsSync(stateFile)) {
      return trial;
    }
    const keepsLogged = checks.map((check) => !rescorable(check));
    if (keepsLogged.some(Boolean) && trial.checks.length !== checks.length) {
      return trial;
    }
    const world = new SavedArea(readBaseline(stateFile));
    const baselines = new Map<number, Baseline>();
    checks.forEach((check, index) => {
      const box = baselineBoxOf(check, anchor);
      if (box !== null) {
        const blocks = blocksWithin(this.#start, box);
        baselines.set(index, { intended: blocks, presented: blocks });
      }
    });
    const result = evaluateCase(this.#definition, { anchor, baselines }, world, trial.finalText, 0);
    const rescored: CheckResult[] = result.checks.map((check, index) =>
      keepsLogged[index] === true ? (trial.checks[index] ?? check) : check,
    );
    return { ...trial, checks: rescored, passed: rescored.length > 0 && rescored.every((check) => check.passed) };
  }
}

/** True for checks that need only blocks in the case's area and the final reply. */
function rescorable(check: CaseCheck): boolean {
  return "block" in check || "count" in check || "copy" in check || "unchanged" in check || "reply" in check;
}

/** The non-air blocks of `baseline` inside `box`, as a check's baseline map. */
function blocksWithin(baseline: RegionBaseline, box: Box): ReturnType<typeof toBlockMap> {
  const rows: [number, number, number, string, Readonly<Record<string, string>>][] = [];
  for (const { position, block } of baselineCells(baseline)) {
    if (contains(box, position) && block.name !== "air") {
      rows.push([position.x, position.y, position.z, block.name, block.properties]);
    }
  }
  return toBlockMap(rows);
}

/** A saved area as the checks' world: blocks inside the area, unknown (null) outside it. */
class SavedArea implements CaseWorld {
  readonly #box: Box;
  readonly #blocks = new Map<string, BlockState>();

  constructor(area: RegionBaseline) {
    this.#box = area.box;
    for (const { position, block } of baselineCells(area)) {
      this.#blocks.set(`${position.x},${position.y},${position.z}`, block);
    }
  }

  blockAt(position: BlockPosition): BlockState | null {
    return contains(this.#box, position)
      ? (this.#blocks.get(`${position.x},${position.y},${position.z}`) ?? AIR)
      : null;
  }

  /** Not saved with the area; checks that read it keep their logged result. */
  inventoryCount(): number {
    return 0;
  }

  /** Not known from the area alone; checks that need it keep their logged result. */
  isOccluder(): boolean {
    return false;
  }
}

function contains(box: Box, position: BlockPosition): boolean {
  return (
    position.x >= box.min.x &&
    position.x <= box.max.x &&
    position.y >= box.min.y &&
    position.y <= box.max.y &&
    position.z >= box.min.z &&
    position.z <= box.max.z
  );
}
