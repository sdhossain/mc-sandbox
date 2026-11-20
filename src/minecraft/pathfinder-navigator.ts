import type { Bot } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";

import { runWithLimits } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError, TimeoutError } from "../utils/errors.ts";
import type { ActionOptions, GoToOptions, MoveResult, Navigator } from "./game-services.ts";
import { distance, toPosition, toVec3, yawFor } from "./geometry.ts";
import { formatPosition, type BlockPosition, type Direction, type Position } from "./types.ts";

const { goals, Movements } = pathfinderPackage;

/** How the bot may move while pathfinding. */
export interface MovementSettings {
  /**
   * Dig through blocks in the way. Off by default so that walking never damages the owner's builds;
   * gathering skills dig explicitly instead.
   */
  readonly canDig: boolean;
  /** Pillar up and bridge with scaffolding blocks. Off by default because it leaves blocks behind. */
  readonly allowScaffolding: boolean;
  /** Jump gaps. */
  readonly allowParkour: boolean;
}

/** Defaults for {@link MovementSettings}. */
export const DEFAULT_MOVEMENT_SETTINGS: MovementSettings = {
  canDig: false,
  allowScaffolding: false,
  allowParkour: true,
};

const DEFAULT_TIMEOUT_MS = 60_000;

/** A mineflayer-pathfinder goal. */
export type PathGoal = InstanceType<typeof goals.Goal>;

/** Options for {@link pathfind}. */
export interface PathfindOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Names the walk in the timeout message. */
  readonly label: string;
}

/**
 * Walks the bot to `goal` with a time limit and an abort signal. Every walk in the lab goes through here.
 *
 * mineflayer-pathfinder 2.4.5 has a trap: `pathfinder.stop()` only sets a flag, which the next path to
 * start then obeys. A stop requested while the bot stands still therefore cancels the *next* walk the
 * moment it begins, with "Path was stopped before it could be completed". So the lab never calls
 * `stop()`: walks are cancelled with {@link cancelPathfinding}, and any stop left over from model code is
 * cleared before each walk starts.
 *
 * @throws TimeoutError, AbortedError, or the pathfinder's own error (no path, goal changed).
 */
export async function pathfind(bot: Bot, goal: PathGoal, options: PathfindOptions): Promise<void> {
  // Setting a goal resets the path, which consumes a leftover stop request before the real walk starts.
  bot.pathfinder.setGoal(null);
  await runWithLimits(() => bot.pathfinder.goto(goal), {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label,
    onCancel: () => {
      cancelPathfinding(bot);
    },
  });
}

/** Stops any walk in progress at once, without leaving a stop request behind (see {@link pathfind}). */
export function cancelPathfinding(bot: Bot): void {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
}

/** {@link Navigator} implemented with mineflayer-pathfinder. The plugin must already be loaded on the bot. */
export class PathfinderNavigator implements Navigator {
  readonly #bot: Bot;

  /**
   * @param bot - A spawned bot with the pathfinder plugin loaded.
   * @param settings - How the bot may move.
   */
  constructor(bot: Bot, settings: MovementSettings = DEFAULT_MOVEMENT_SETTINGS) {
    this.#bot = bot;
    const movements = new Movements(bot);
    movements.canDig = settings.canDig;
    movements.allow1by1towers = settings.allowScaffolding;
    movements.scafoldingBlocks = settings.allowScaffolding ? movements.scafoldingBlocks : [];
    movements.allowParkour = settings.allowParkour;
    movements.allowSprinting = true;
    bot.pathfinder.setMovements(movements);
  }

  /** Walks to within `range` blocks of `target`. */
  async goTo(target: BlockPosition, options: GoToOptions = {}): Promise<MoveResult> {
    const range = options.range ?? 1;
    const goal =
      range <= 0
        ? new goals.GoalBlock(target.x, target.y, target.z)
        : new goals.GoalNear(target.x, target.y, target.z, range);
    return this.#follow(goal, target, `walking to ${formatPosition(target)}`, options);
  }

  /** Walks to within `range` blocks of a player the bot can see. */
  async goToPlayer(username: string, options: GoToOptions = {}): Promise<MoveResult> {
    const entity = this.#bot.players[username]?.entity;
    if (entity === undefined) {
      throw new ActionError(`Player ${username} is not in view (offline, or too far away for the bot to see).`);
    }
    const target = {
      x: Math.floor(entity.position.x),
      y: Math.floor(entity.position.y),
      z: Math.floor(entity.position.z),
    };
    const range = options.range ?? 2;
    const goal = new goals.GoalNear(target.x, target.y, target.z, range);
    return this.#follow(goal, target, `walking to ${username}`, { ...options, range });
  }

  /** Turns the head to look at `target`. */
  async lookAt(target: Position, options: ActionOptions = {}): Promise<void> {
    await runWithLimits(() => this.#bot.lookAt(toVec3(target), true), {
      signal: options.signal,
      timeoutMs: 5_000,
      label: "looking",
    });
  }

  /** Turns to face a horizontal direction, level with the horizon. */
  async face(direction: Direction, options: ActionOptions = {}): Promise<void> {
    await runWithLimits(() => this.#bot.look(yawFor(direction), 0, true), {
      signal: options.signal,
      timeoutMs: 5_000,
      label: "turning",
    });
  }

  /** Stops pathfinding and releases all movement keys. */
  stop(): void {
    cancelPathfinding(this.#bot);
  }

  async #follow(goal: PathGoal, target: BlockPosition, label: string, options: GoToOptions): Promise<MoveResult> {
    const started = performance.now();
    const range = options.range ?? 1;
    if (this.#isWithin(target, range)) {
      return this.#result(target, started);
    }
    try {
      await pathfind(this.#bot, goal, {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
        label,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const here = toPosition(this.#bot.entity.position);
      const left = distance(here, target).toFixed(1);
      const why = error instanceof TimeoutError ? "timed out" : `failed (${errorMessage(error)})`;
      throw new ActionError(
        `${capitalise(label)} ${why}. The bot stopped at ${formatPosition(here)}, ${left} blocks from the target (range ${range}).`,
        { cause: error },
      );
    }
    return this.#result(target, started);
  }

  /** Same test as the pathfinder's `GoalNear` and `GoalBlock`, on the block the bot stands in. */
  #isWithin(target: BlockPosition, range: number): boolean {
    const here = this.#bot.entity.position.floored();
    const dx = here.x - target.x;
    const dy = here.y - target.y;
    const dz = here.z - target.z;
    return range <= 0 ? dx === 0 && dy === 0 && dz === 0 : dx * dx + dy * dy + dz * dz <= range * range;
  }

  #result(target: BlockPosition, started: number): MoveResult {
    const position = toPosition(this.#bot.entity.position);
    return {
      position,
      distance: Math.round(distance(position, { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }) * 10) / 10,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
