import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "../utils/errors.ts";
import type { CheckResult } from "./case-checks.ts";
import { formatUsd } from "../utils/text.ts";
import { endedWithQuestion, type TrialRecord } from "./trial-runner.ts";

/** A trial as logged, with where its end state was saved. */
export interface LoggedTrial extends TrialRecord {
  /** Short id of the saved end state, for `!load <id>`: `t1`, `t2`, ... across every case. */
  readonly stateId: string;
  /** The case's area as the trial left it (a baseline file), or null when it could not be recorded. */
  readonly stateFile: string | null;
  /** The world checkpoint saved after the trial, or null. */
  readonly checkpoint: string | null;
  /**
   * Set when the trial was scored again and the new verdict saved (`trials --summary --rescore --save`): the
   * verdict and checks as first logged, and when they were replaced.
   */
  readonly asLogged?: {
    readonly passed: boolean;
    readonly checks: readonly CheckResult[];
    readonly rescoredAt: string;
  };
}

/** The conditions a trial ran under, as the summary groups them. */
export interface TrialConditions {
  readonly model: string;
  readonly harness: string;
  readonly gameMode: string;
  readonly answersQuestions: boolean;
}

/** What trials logged by older versions lack, with the values those trials had. */
const OLDER_TRIAL_DEFAULTS = { answersQuestions: false, autoReplies: [] } as const;

const CSV_COLUMNS = [
  "state_id",
  "case",
  "model",
  "harness",
  "game_mode",
  "trial",
  "passed",
  "blocks_right",
  "blocks",
  "extra_blocks",
  "matching",
  "total",
  "wrong_cells",
  "plain_matching",
  "bottom_y",
  "status",
  "answers_questions",
  "auto_replies",
  "steps",
  "tool_calls",
  "cost_usd",
  "minutes",
  "run_id",
  "checkpoint",
  "started_at",
] as const;

/** The default trials folder under the runs directory. */
export const TRIALS_FOLDER = "trials";

/**
 * The trials of one case, kept as `runs/trials/<case>.jsonl` (every detail) and `<case>.csv` (one row per
 * trial, for spreadsheets). Each trial is appended as soon as it finishes. A set of trials can go to its
 * own folder instead (`runs/trials-<name>/`), for example to keep one harness's results apart.
 */
export class TrialLog {
  readonly jsonlPath: string;
  readonly csvPath: string;

  /**
   * @param runsDir - The lab's runs directory.
   * @param caseId - The case whose trials this log holds.
   * @param folder - The folder under `runsDir`: `trials`, or a name starting with `trials-`.
   */
  constructor(runsDir: string, caseId: string, folder = TRIALS_FOLDER) {
    if (folder !== TRIALS_FOLDER && !folder.startsWith(`${TRIALS_FOLDER}-`)) {
      throw new ConfigError(`A trials folder must be named "${TRIALS_FOLDER}" or start with "${TRIALS_FOLDER}-".`);
    }
    const directory = join(runsDir, folder);
    mkdirSync(directory, { recursive: true });
    this.jsonlPath = join(directory, `${caseId}.jsonl`);
    this.csvPath = join(directory, `${caseId}.csv`);
  }

  /**
   * Every trial logged for any case in any trials folder under `runsDir`, oldest first within each log.
   * Reading every folder keeps state ids unique and lets `!load` find any trial.
   */
  static all(runsDir: string): LoggedTrial[] {
    if (!existsSync(runsDir)) {
      return [];
    }
    return readdirSync(runsDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && (entry.name === TRIALS_FOLDER || entry.name.startsWith(`${TRIALS_FOLDER}-`)),
      )
      .map((entry) => join(runsDir, entry.name))
      .sort()
      .flatMap((directory) =>
        readdirSync(directory)
          .filter((file) => file.endsWith(".jsonl"))
          .sort()
          .flatMap((file) => readLines(join(directory, file))),
      );
  }

  /** The next free state id: one more than the highest `t<n>` logged for any case. */
  static nextStateId(runsDir: string): string {
    const numbers = TrialLog.all(runsDir).map((trial) => Number(/^t(\d+)$/.exec(trial.stateId)?.[1] ?? 0));
    return `t${Math.max(0, ...numbers) + 1}`;
  }

  /** Appends one trial to both files. */
  append(record: LoggedTrial): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`);
    if (this.#csvHasCurrentColumns()) {
      appendFileSync(this.csvPath, `${csvRow(record).join(",")}\n`);
      return;
    }
    // A new CSV, or one with an older set of columns: write it again from the full log.
    const rows = [CSV_COLUMNS.join(","), ...this.read().map((trial) => csvRow(trial).join(","))];
    writeFileSync(this.csvPath, `${rows.join("\n")}\n`);
  }

  /** Every trial recorded so far, oldest first. */
  read(): LoggedTrial[] {
    return existsSync(this.jsonlPath) ? readLines(this.jsonlPath) : [];
  }

  /**
   * Replaces the log with `records`, after copying the current files to `<file>.<backupSuffix>` (a name that
   * does not end in `.jsonl`, so the copy is never read as a log).
   */
  rewrite(records: readonly LoggedTrial[], backupSuffix: string): void {
    for (const path of [this.jsonlPath, this.csvPath]) {
      if (existsSync(path)) {
        copyFileSync(path, `${path}.${backupSuffix}`);
      }
    }
    writeFileSync(this.jsonlPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    const rows = [CSV_COLUMNS.join(","), ...records.map((record) => csvRow(record).join(","))];
    writeFileSync(this.csvPath, `${rows.join("\n")}\n`);
  }

  #csvHasCurrentColumns(): boolean {
    if (!existsSync(this.csvPath)) {
      return false;
    }
    const [header] = readFileSync(this.csvPath, "utf8").split("\n", 1);
    return header === CSV_COLUMNS.join(",");
  }
}

function readLines(path: string): LoggedTrial[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ ...OLDER_TRIAL_DEFAULTS, ...(JSON.parse(line) as LoggedTrial) }));
}

/**
 * One line per set of conditions (model, harness, game mode, and whether questions were answered):
 * trials, passes, trials in which the model stopped to ask, mean share of blocks right, mean cost and time.
 */
export function summariseTrials(records: readonly TrialRecord[]): string {
  const groups = new Map<string, TrialRecord[]>();
  for (const record of records) {
    const key = conditionsOf(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const title = "model | harness | mode";
  const width = Math.max(title.length, ...[...groups.keys()].map((key) => key.length));
  const lines = [
    `${title.padEnd(width)}  trials  passed  asked  blocks right (mean)  extra (mean)  cost (mean)  minutes (mean)`,
  ];
  for (const [key, list] of groups) {
    const passed = list.filter((record) => record.passed).length;
    const asked = list.filter(askedAQuestion).length;
    const ratios = list.flatMap((record) => {
      const metrics = firstMetrics(record);
      return metrics?.blocksRight === undefined || metrics.blocks === undefined || metrics.blocks === 0
        ? []
        : [metrics.blocksRight / metrics.blocks];
    });
    const extras = list.flatMap((record) => {
      const extra = firstMetrics(record)?.extraBlocks;
      return extra === undefined ? [] : [extra];
    });
    const mean = (values: readonly number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const matched = ratios.length === 0 ? "-" : `${(100 * mean(ratios)).toFixed(1)}%`;
    const extra = extras.length === 0 ? "-" : mean(extras).toFixed(1);
    lines.push(
      `${key.padEnd(width)}  ${String(list.length).padStart(6)}  ${`${passed}/${list.length}`.padStart(6)}  ${`${asked}/${list.length}`.padStart(5)}  ${matched.padStart(19)}  ${extra.padStart(12)}  ${formatUsd(mean(list.map((record) => record.costUsd))).padStart(11)}  ${(mean(list.map((record) => record.durationMs)) / 60_000).toFixed(1).padStart(14)}`,
    );
  }
  return lines.join("\n");
}

/** How many of `records` ran under `conditions`. */
export function countTrials(records: readonly TrialRecord[], conditions: TrialConditions): number {
  return records.filter(
    (record) =>
      record.model === conditions.model &&
      record.harness === conditions.harness &&
      record.gameMode === conditions.gameMode &&
      record.answersQuestions === conditions.answersQuestions,
  ).length;
}

/** The conditions a trial ran under. Trials whose questions went unanswered are kept apart. */
function conditionsOf(record: TrialRecord): string {
  return `${record.model} | ${record.harness} | ${record.gameMode}${record.answersQuestions ? "" : " | no auto-reply"}`;
}

/** True when the model stopped to ask during the trial, answered or not. */
export function askedAQuestion(record: TrialRecord): boolean {
  return record.autoReplies.length > 0 || endedWithQuestion(record.status, record.passed, record.finalText);
}

/** The numbers of the first check that has any (the copy check, for mirror cases). */
export function firstMetrics(record: TrialRecord): Readonly<Record<string, number>> | undefined {
  return record.checks.find((check) => check.metrics !== undefined)?.metrics;
}

/**
 * How many trials a copy check scored before untouched ground stopped counting as extra blocks: their
 * metrics have no `groundCells`. Their verdicts can differ from what the current checks give.
 */
export function olderScoringCount(records: readonly TrialRecord[]): number {
  return records.filter((record) => {
    const metrics = firstMetrics(record);
    return metrics?.blocksRight !== undefined && metrics.groundCells === undefined;
  }).length;
}

/** `FAIL: 288/295 blocks right, 7 extra`, or `PASS: 2/2 checks` for cases without a copy check. */
export function verdictOf(record: TrialRecord): string {
  const outcome = record.passed ? "PASS" : "FAIL";
  const metrics = firstMetrics(record);
  if (metrics?.blocksRight !== undefined && metrics.blocks !== undefined) {
    return `${outcome}: ${metrics.blocksRight}/${metrics.blocks} blocks right, ${metrics.extraBlocks ?? 0} extra`;
  }
  return `${outcome}: ${record.checks.filter((check) => check.passed).length}/${record.checks.length} checks`;
}

function csvRow(record: LoggedTrial): string[] {
  const metrics = firstMetrics(record) ?? {};
  const value = (key: string): string => (metrics[key] === undefined ? "" : String(metrics[key]));
  return [
    record.stateId,
    record.caseId,
    record.model,
    record.harness,
    record.gameMode,
    String(record.trial),
    record.passed ? "true" : "false",
    value("blocksRight"),
    value("blocks"),
    value("extraBlocks"),
    value("matching"),
    value("total"),
    value("wrongCells"),
    value("plainMatching"),
    value("bottomY"),
    record.status,
    String(record.answersQuestions),
    String(record.autoReplies.length),
    String(record.steps),
    String(record.toolCalls),
    record.costUsd.toFixed(4),
    (record.durationMs / 60_000).toFixed(2),
    record.runId,
    record.checkpoint ?? "",
    record.startedAt,
  ];
}
