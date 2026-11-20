import type { Agent } from "../agent/agent.ts";
import { ControlCommand } from "../agent/chat-addressing.ts";
import type { BlockPosition } from "../minecraft/types.ts";
import type { EventBus } from "../observability/event-bus.ts";
import type { EventPayloads } from "../observability/events.ts";
import { LabError } from "../utils/errors.ts";
import { MessageSource, TurnStatus } from "../utils/names.ts";
import type { CaseResult, CheckResult } from "./case-checks.ts";

/** Sent in the owner's name when the model ends its turn with a question, since nobody is there to answer. */
export const AUTO_REPLY = "I'm not around; use your best judgement and finish.";
/** Questions answered per trial. A model that asks again after the answer ends the trial there. */
const MAX_AUTO_REPLIES = 1;

/** A question the model ended a turn with, and the automatic answer it got. */
export interface AutoReply {
  /** The turn the question ended. */
  readonly turn: number;
  /** The model's final text in that turn. */
  readonly question: string;
  readonly reply: string;
}

/** Everything recorded about one trial of a case. */
export interface TrialRecord {
  readonly caseId: string;
  readonly trial: number;
  readonly model: string;
  readonly harness: string;
  readonly gameMode: string;
  readonly runId: string;
  /** Where the case's scene was anchored; null when the case never started. */
  readonly anchor: BlockPosition | null;
  readonly startedAt: string;
  /** The case's checks after the last turn. */
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  /** Whether the trial answered the model's questions. Trials logged before this existed did not. */
  readonly answersQuestions: boolean;
  /** The questions the trial answered automatically; empty when the model did not stop to ask. */
  readonly autoReplies: readonly AutoReply[];
  /** How the last turn ended: completed, stopped, budget, failed, or `timeout` when the runner gave up waiting. */
  readonly status: string;
  /** Steps, tool calls, cost and time, over all of the trial's turns. */
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly costUsd: number;
  readonly durationMs: number;
  /** The model's final text in the last turn. */
  readonly finalText: string;
}

/** What a trial needs from the agent it runs on. */
export type TrialAgent = Pick<Agent, "name" | "config" | "control" | "submit">;

/** How to run a case's trials. */
export interface TrialOptions {
  readonly caseId: string;
  /** The owner the case is started for. Automatic answers are sent in their name. */
  readonly owner: string;
  /** Rebuild a flattened case's site even when it looks built on, as `!case <id> force`. */
  readonly force?: boolean;
  /** Answer once when the model ends a turn with a question and the case has not passed (default true). */
  readonly answerQuestions?: boolean;
}

/** One finished turn of a trial: how it ended, and the case's checks after it. */
interface FinishedTurn {
  /** Null when the turn's end was not seen, which does not happen in practice. */
  readonly end: EventPayloads["turn.ended"] | null;
  readonly result: CaseResult;
}

/** Extra time after the turn's own time limit before the runner stops waiting. */
const GRACE_MS = 5 * 60_000;
/** After stopping a turn that overran, how long to wait for its result. */
const STOP_WAIT_MS = 60_000;

/**
 * True when a turn ended with the model asking something instead of finishing: the model ended the
 * turn itself, its reply contains a question mark, and the case has not passed.
 */
export function endedWithQuestion(status: string, passed: boolean, finalText: string): boolean {
  return status === TurnStatus.COMPLETED && !passed && finalText.includes("?");
}

/**
 * Runs one case on one agent again and again, unattended, the way `!case <id>` does from the terminal.
 *
 * Each trial starts a fresh run (empty conversation, area reset by the case), waits for the agent's turn
 * to end and the case's checks to be scored, and returns everything as a {@link TrialRecord}. Nobody is
 * there to answer questions, so when the model ends its turn by asking one, the trial answers once with
 * {@link AUTO_REPLY} and waits for the next turn; the record keeps the question.
 */
export class TrialRunner {
  readonly #agent: TrialAgent;
  readonly #bus: EventBus;
  readonly #options: TrialOptions;
  readonly #answerQuestions: boolean;
  readonly #timeoutMs: number;

  /**
   * @param agent - A started agent.
   * @param bus - The lab's event bus, on which the agent's results arrive.
   * @param options - The case, the owner, and how to run it.
   */
  constructor(agent: TrialAgent, bus: EventBus, options: TrialOptions) {
    this.#agent = agent;
    this.#bus = bus;
    this.#options = options;
    this.#answerQuestions = options.answerQuestions ?? true;
    this.#timeoutMs = agent.config.budget.maxTurnMinutes * 60_000 + GRACE_MS;
  }

  /**
   * Runs trial number `trial`.
   *
   * @throws LabError when the case cannot start (for example RCON is missing or the baseline is absent).
   */
  async run(trial: number): Promise<TrialRecord> {
    const startedAt = new Date().toISOString();
    const { caseId, owner } = this.#options;
    const watcher = new RunWatcher(this.#bus, this.#agent.name, caseId);
    try {
      const argument = this.#options.force === true ? `${caseId} force` : caseId;
      const reply = await this.#agent.control(ControlCommand.CASE, owner, MessageSource.CLI, argument);
      if (!reply.startsWith(`Case ${caseId} (`)) {
        throw new LabError(reply);
      }
      const turns: FinishedTurn[] = [];
      const autoReplies: AutoReply[] = [];
      let timedOut = false;
      for (;;) {
        const turn = await watcher.next(this.#timeoutMs);
        if (turn === null) {
          // Overran: stop the turn, which still ends it and scores the case.
          timedOut = true;
          await this.#agent.control(ControlCommand.STOP, owner, MessageSource.CLI);
          const stopped = await watcher.next(STOP_WAIT_MS);
          if (stopped !== null) {
            turns.push(stopped);
          }
          break;
        }
        turns.push(turn);
        if (!this.#shouldAnswer(turn, autoReplies.length)) {
          break;
        }
        autoReplies.push({ turn: turn.result.turn, question: turn.end?.finalText ?? "", reply: AUTO_REPLY });
        this.#agent.submit({ source: MessageSource.TRIAL, from: owner, text: AUTO_REPLY, receivedAtMs: Date.now() });
      }
      return this.#record(trial, startedAt, watcher, turns, autoReplies, timedOut);
    } finally {
      watcher.close();
    }
  }

  #shouldAnswer(turn: FinishedTurn, answered: number): boolean {
    return (
      this.#answerQuestions &&
      answered < MAX_AUTO_REPLIES &&
      turn.end !== null &&
      endedWithQuestion(turn.end.status, turn.result.passed, turn.end.finalText)
    );
  }

  #record(
    trial: number,
    startedAt: string,
    watcher: RunWatcher,
    turns: readonly FinishedTurn[],
    autoReplies: readonly AutoReply[],
    timedOut: boolean,
  ): TrialRecord {
    const last = turns.at(-1);
    const sum = (value: (end: EventPayloads["turn.ended"]) => number): number =>
      turns.reduce((total, turn) => total + (turn.end === null ? 0 : value(turn.end)), 0);
    return {
      caseId: this.#options.caseId,
      trial,
      model: this.#agent.config.model,
      harness: this.#agent.config.harness,
      gameMode: this.#agent.config.privileges.gameMode,
      runId: watcher.runId,
      anchor: watcher.anchor,
      startedAt,
      passed: last?.result.passed ?? false,
      checks: last?.result.checks ?? [],
      answersQuestions: this.#answerQuestions,
      autoReplies,
      status: timedOut ? "timeout" : (last?.end?.status ?? "unknown"),
      steps: sum((end) => end.totals.steps),
      toolCalls: sum((end) => end.totals.toolCalls),
      toolErrors: sum((end) => end.totals.toolErrors),
      costUsd: sum((end) => end.totals.costUsd),
      durationMs: sum((end) => end.durationMs),
      finalText: last?.end?.finalText ?? "",
    };
  }
}

/**
 * Follows the run that a `!case` starts, and hands out its turns as they finish (a turn has finished
 * once the case's checks have been scored after it).
 */
class RunWatcher {
  readonly #unsubscribe: () => void;
  readonly #finished: FinishedTurn[] = [];
  #runId: string | null = null;
  #anchor: BlockPosition | null = null;
  #lastEnd: EventPayloads["turn.ended"] | null = null;
  #wake: (() => void) | null = null;

  /** Subscribes at once, so that nothing the case does is missed. Call {@link close} when done. */
  constructor(bus: EventBus, agentName: string, caseId: string) {
    this.#unsubscribe = bus.subscribe((event) => {
      if (event.agent !== agentName) {
        return;
      }
      // `!case` starts a new run, and case.started is the first event that carries its id.
      if (event.type === "case.started" && event.data.id === caseId && this.#runId === null) {
        this.#runId = event.runId;
        this.#anchor = event.data.anchor;
        return;
      }
      if (this.#runId === null || event.runId !== this.#runId) {
        return;
      }
      if (event.type === "turn.ended") {
        this.#lastEnd = event.data;
      } else if (event.type === "case.result") {
        this.#finished.push({ end: this.#lastEnd, result: event.data });
        this.#lastEnd = null;
        this.#wake?.();
      }
    });
  }

  /** The run's id, or "" when the case never started. */
  get runId(): string {
    return this.#runId ?? "";
  }

  /** Where the case was anchored, or null when it never started. */
  get anchor(): BlockPosition | null {
    return this.#anchor;
  }

  /** The next finished turn, or null when none finishes within `ms`. */
  async next(ms: number): Promise<FinishedTurn | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const turn = this.#finished.shift();
      if (turn !== undefined) {
        return turn;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }

  /** Stops following the run. */
  close(): void {
    this.#unsubscribe();
  }
}
