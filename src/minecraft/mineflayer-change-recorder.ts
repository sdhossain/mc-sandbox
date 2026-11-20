import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";

import type { BlockChangeRecorder } from "./game-services.ts";
import { blockStateOf } from "./names.ts";
import { ChangeCause, type BlockChange, type BlockPosition, type Box } from "./types.ts";

/** A change is attributed to the bot if it happens this soon after the bot announced it. */
const EXPECTATION_WINDOW_MS = 6_000;
/** Older changes are forgotten once the log grows past this. Run directories keep the full history. */
const MAX_CHANGES = 100_000;

/**
 * {@link BlockChangeRecorder} fed by Mineflayer's `blockUpdate` events.
 *
 * It sees every block change in the chunks the bot has loaded, whoever made it. Changes at positions
 * the bot announced through {@link expectChange} shortly before are marked as caused by the bot.
 */
export class MineflayerChangeRecorder implements BlockChangeRecorder {
  readonly #bot: Bot;
  readonly #changes: BlockChange[] = [];
  readonly #listeners = new Set<(change: BlockChange) => void>();
  readonly #expected = new Map<string, number>();
  readonly #onBlockUpdate: (before: Block | null, after: Block | null) => void;
  #seq = 0;

  /** @param bot - A spawned bot. Call {@link dispose} when the bot disconnects. */
  constructor(bot: Bot) {
    this.#bot = bot;
    this.#onBlockUpdate = (before, after) => {
      this.#record(before, after);
    };
    bot.on("blockUpdate", this.#onBlockUpdate);
  }

  /** Sequence number of the newest change. */
  lastSeq(): number {
    return this.#seq;
  }

  /** Changes after `seq`, optionally inside `box`. */
  since(seq: number, box?: Box): BlockChange[] {
    return this.#changes.filter((change) => change.seq > seq && (box === undefined || inBox(change.position, box)));
  }

  /** Registers a listener for new changes. */
  onChange(listener: (change: BlockChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Marks `position` as about to be changed by the bot. */
  expectChange(position: BlockPosition): void {
    this.#expected.set(key(position), Date.now() + EXPECTATION_WINDOW_MS);
  }

  /** Stops listening to the bot. */
  dispose(): void {
    this.#bot.removeListener("blockUpdate", this.#onBlockUpdate);
    this.#listeners.clear();
  }

  #record(before: Block | null, after: Block | null): void {
    if (after === null || (before !== null && before.stateId === after.stateId)) {
      return;
    }
    const position = { x: after.position.x, y: after.position.y, z: after.position.z };
    const positionKey = key(position);
    const expiry = this.#expected.get(positionKey);
    const now = Date.now();
    const byBot = expiry !== undefined && expiry >= now;
    if (expiry !== undefined && expiry < now) {
      this.#expected.delete(positionKey);
    }
    this.#seq += 1;
    const change: BlockChange = {
      seq: this.#seq,
      timeMs: now,
      gameTick: this.#bot.time.age,
      position,
      before: before === null ? null : blockStateOf(before),
      after: blockStateOf(after),
      cause: byBot ? ChangeCause.BOT : ChangeCause.OTHER,
    };
    this.#changes.push(change);
    if (this.#changes.length > MAX_CHANGES) {
      this.#changes.splice(0, this.#changes.length - MAX_CHANGES);
    }
    for (const listener of this.#listeners) {
      listener(change);
    }
  }
}

function key(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function inBox(position: BlockPosition, box: Box): boolean {
  return (
    position.x >= box.min.x &&
    position.x <= box.max.x &&
    position.y >= box.min.y &&
    position.y <= box.max.y &&
    position.z >= box.min.z &&
    position.z <= box.max.z
  );
}
