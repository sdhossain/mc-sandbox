import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";

import { runWithLimits, sleep } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";
import type {
  BlockBreaker,
  BlockChangeRecorder,
  DigOptions,
  DigResult,
  InventoryManager,
  Navigator,
} from "./game-services.ts";
import { blockCenter, distance, toVec3 } from "./geometry.ts";
import { blockStateOf } from "./names.ts";
import { pathfind } from "./pathfinder-navigator.ts";
import { formatPosition, isAir, type BlockPosition, type ItemCount } from "./types.ts";

const { goals } = pathfinderPackage;

const REACH = 4.3;
const EYE_HEIGHT = 1.62;
const APPROACH_TIMEOUT_MS = 45_000;
const COLLECT_RADIUS = 4;
const COLLECT_TIMEOUT_MS = 6_000;

/** {@link BlockBreaker} for a Mineflayer bot: approach, pick the fastest tool, dig, verify, collect the drop. */
export class MineflayerBreaker implements BlockBreaker {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;
  readonly #navigator: Navigator;
  readonly #inventory: InventoryManager;
  readonly #changes: BlockChangeRecorder;

  /**
   * @param bot - A spawned bot with the pathfinder plugin loaded.
   * @param mcData - Data for the server's version.
   * @param navigator - Used to walk into reach and to the drop.
   * @param inventory - Used to equip tools and measure what was collected.
   * @param changes - Told about the dig so the change is attributed to the bot.
   */
  constructor(
    bot: Bot,
    mcData: IndexedData,
    navigator: Navigator,
    inventory: InventoryManager,
    changes: BlockChangeRecorder,
  ) {
    this.#bot = bot;
    this.#mcData = mcData;
    this.#navigator = navigator;
    this.#inventory = inventory;
    this.#changes = changes;
  }

  /** Breaks the block at `target` and verifies it is gone. */
  async dig(target: BlockPosition, options: DigOptions = {}): Promise<DigResult> {
    const block = this.#bot.blockAt(toVec3(target), false);
    if (block === null) {
      throw new ActionError(`The chunk at ${formatPosition(target)} is not loaded; move closer first.`);
    }
    if (isAir(block.name) || block.name === "water" || block.name === "lava") {
      throw new ActionError(`There is no block to dig at ${formatPosition(target)} (it is ${block.name}).`);
    }
    const creative = this.#bot.game.gameMode === "creative";
    if (!creative && block.hardness < 0) {
      throw new ActionError(`${block.name} at ${formatPosition(target)} cannot be broken in survival.`);
    }
    const broken = blockStateOf(block);
    const before = countsByName(this.#inventory.totals());

    if (options.approach !== false) {
      await this.#approach(target, options.signal);
    }
    const reach = this.#eyeDistance(target);
    if (reach > REACH + 0.7) {
      throw new ActionError(
        `${formatPosition(target)} is ${reach.toFixed(1)} blocks away, out of reach. Move closer first.`,
      );
    }
    const tool = creative ? null : await this.#equipBestTool(block, options.signal);
    const digMs = this.#bot.digTime(block);
    this.#changes.expectChange(target);
    try {
      await runWithLimits(() => this.#bot.dig(block, true), {
        signal: options.signal,
        timeoutMs: Math.max(5_000, digMs * 2 + 3_000),
        onCancel: () => {
          this.#bot.stopDigging();
        },
        label: `digging ${block.name}`,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ActionError(`Digging ${block.name} at ${formatPosition(target)} failed: ${errorMessage(error)}.`, {
        cause: error,
      });
    }
    const after = this.#bot.blockAt(toVec3(target), false);
    if (after !== null && after.name === block.name) {
      throw new ActionError(`${block.name} at ${formatPosition(target)} is still there after digging.`);
    }

    const warning =
      !creative && !this.#canHarvest(block, tool) ? `${block.name} needs a better tool to drop anything.` : null;
    if (options.collectDrops ?? !creative) {
      await this.#collectDrops(target, options.signal);
    }
    const collected = difference(countsByName(this.#inventory.totals()), before);
    return { position: target, broken, tool, collected, warning };
  }

  async #approach(target: BlockPosition, signal: AbortSignal | undefined): Promise<void> {
    if (this.#eyeDistance(target) <= REACH) {
      return;
    }
    const goal = new goals.GoalLookAtBlock(toVec3(target), this.#bot.world, { reach: REACH });
    try {
      await pathfind(this.#bot, goal, {
        timeoutMs: APPROACH_TIMEOUT_MS,
        signal,
        label: `walking into reach of ${formatPosition(target)}`,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ActionError(`Could not get within reach of ${formatPosition(target)}: ${errorMessage(error)}.`, {
        cause: error,
      });
    }
  }

  /** Equips the inventory item that digs `block` fastest. Returns its name, or null for bare hands. */
  async #equipBestTool(block: Block, signal: AbortSignal | undefined): Promise<string | null> {
    let best: { name: string; time: number } = { name: "", time: block.digTime(null, false, false, false, [], []) };
    for (const item of this.#bot.inventory.items()) {
      const time = block.digTime(item.type, false, false, false, [], []);
      if (time < best.time) {
        best = { name: item.name, time };
      }
    }
    if (best.name === "") {
      if (this.#bot.heldItem !== null) {
        await runWithLimits(() => this.#bot.unequip("hand"), { signal, timeoutMs: 5_000, label: "emptying the hand" });
      }
      return null;
    }
    await this.#inventory.equip(best.name, "hand", signal === undefined ? {} : { signal });
    return best.name;
  }

  #canHarvest(block: Block, tool: string | null): boolean {
    if (block.harvestTools === undefined) {
      return true;
    }
    const toolId = tool === null ? undefined : this.#mcData.itemsByName[tool]?.id;
    return toolId !== undefined && block.harvestTools[String(toolId)] === true;
  }

  async #collectDrops(target: BlockPosition, signal: AbortSignal | undefined): Promise<void> {
    await sleep(300, signal);
    const center = blockCenter(target);
    const drops = Object.values(this.#bot.entities).filter(
      (entity) => entity.name === "item" && entity.position.distanceTo(center) <= COLLECT_RADIUS,
    );
    for (const drop of drops) {
      if (!drop.isValid) {
        continue;
      }
      const at = drop.position.floored();
      try {
        await this.#navigator.goTo(
          { x: at.x, y: at.y, z: at.z },
          { range: 0, timeoutMs: COLLECT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        );
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        // An unreachable drop is not a failed dig; the inventory difference reports what was collected.
      }
    }
    await sleep(250, signal);
  }

  #eyeDistance(target: BlockPosition): number {
    return distance(this.#bot.entity.position.offset(0, EYE_HEIGHT, 0), blockCenter(target));
  }
}

function countsByName(items: readonly ItemCount[]): Map<string, number> {
  return new Map(items.map((item) => [item.name, item.count]));
}

function difference(after: Map<string, number>, before: Map<string, number>): ItemCount[] {
  const gained: ItemCount[] = [];
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0);
    if (delta > 0) {
      gained.push({ name, count: delta });
    }
  }
  return gained;
}
