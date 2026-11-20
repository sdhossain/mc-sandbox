import { z } from "zod";

/** Limits that end a turn or a run before it runs away. */
export const BudgetSchema = z.strictObject({
  /** Model calls per turn. */
  maxStepsPerTurn: z.int().positive().default(150),
  /** Wall-clock minutes per turn. */
  maxTurnMinutes: z.number().positive().default(30),
  /** US dollars per turn. */
  maxTurnCostUsd: z.number().positive().default(3),
  /** US dollars per run (until `!reset`). */
  maxRunCostUsd: z.number().positive().default(20),
});

/** See {@link BudgetSchema}. */
export type BudgetConfig = z.infer<typeof BudgetSchema>;

/** Which limit was hit, with its configured value and the value reached. */
export interface BudgetExceeded {
  readonly budget: "steps per turn" | "minutes per turn" | "dollars per turn" | "dollars per run";
  readonly limit: number;
  readonly value: number;
}

/** Tracks one turn against the budget. */
export class TurnBudget {
  readonly #config: BudgetConfig;
  readonly #startedAt = performance.now();
  readonly #runCostAtStart: number;
  #steps = 0;
  #turnCost = 0;

  /**
   * @param config - The agent's limits.
   * @param runCostSoFar - Dollars the run had spent before this turn.
   */
  constructor(config: BudgetConfig, runCostSoFar: number) {
    this.#config = config;
    this.#runCostAtStart = runCostSoFar;
  }

  /** Records one model call and its cost. */
  recordStep(costUsd: number): void {
    this.#steps += 1;
    this.#turnCost += costUsd;
  }

  /** Model calls so far in this turn. */
  get steps(): number {
    return this.#steps;
  }

  /** Milliseconds since the turn started. */
  get elapsedMs(): number {
    return performance.now() - this.#startedAt;
  }

  /** The first limit reached, or null when another step may run. */
  exceeded(): BudgetExceeded | null {
    const config = this.#config;
    if (this.#steps >= config.maxStepsPerTurn) {
      return { budget: "steps per turn", limit: config.maxStepsPerTurn, value: this.#steps };
    }
    const minutes = this.elapsedMs / 60_000;
    if (minutes >= config.maxTurnMinutes) {
      return { budget: "minutes per turn", limit: config.maxTurnMinutes, value: Math.round(minutes * 10) / 10 };
    }
    if (this.#turnCost >= config.maxTurnCostUsd) {
      return { budget: "dollars per turn", limit: config.maxTurnCostUsd, value: round(this.#turnCost) };
    }
    const runCost = this.#runCostAtStart + this.#turnCost;
    if (runCost >= config.maxRunCostUsd) {
      return { budget: "dollars per run", limit: config.maxRunCostUsd, value: round(runCost) };
    }
    return null;
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
