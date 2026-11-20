import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

import { runWithLimits, sleep, throwIfAborted } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";
import type { ActionOptions, BlockChangeRecorder, InventoryManager, Interactor, Navigator } from "./game-services.ts";
import { blockCenter, distance, offset, toVec3 } from "./geometry.ts";
import { blockStateOf, requireItemName } from "./names.ts";
import { formatPosition, type BlockPosition, type BlockState } from "./types.ts";

const REACH = 4.3;
const EYE_HEIGHT = 1.62;
/** Items used by pointing at a block and pressing "use" rather than by clicking a block face. */
const AIM_AND_USE_ITEMS = new Set(["water_bucket", "lava_bucket", "bucket", "powder_snow_bucket"]);
const ATTACK_COOLDOWN_MS = 650;

/** {@link Interactor} for a Mineflayer bot. */
export class MineflayerInteractor implements Interactor {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;
  readonly #navigator: Navigator;
  readonly #inventory: InventoryManager;
  readonly #changes: BlockChangeRecorder;

  /**
   * @param bot - A spawned bot with the pathfinder plugin loaded.
   * @param mcData - Data for the server's version.
   * @param navigator - Used to walk into reach.
   * @param inventory - Used to hold the right item.
   * @param changes - Told about interactions so resulting block changes are attributed to the bot.
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

  /** Right-clicks a block with whatever is held. */
  async activateBlock(position: BlockPosition, options: ActionOptions = {}): Promise<BlockState> {
    const block = this.#requireBlock(position);
    await this.#approach(position, options.signal);
    this.#changes.expectChange(position);
    await this.#guard(`using ${block.name}`, options.signal, () => this.#bot.activateBlock(block));
    await sleep(250, options.signal);
    return this.#readBack(position);
  }

  /** Holds `itemName` and uses it on the block at `position`. */
  async useItemOn(position: BlockPosition, itemName: string, options: ActionOptions = {}): Promise<BlockState> {
    const item = requireItemName(this.#mcData, itemName);
    const block = this.#requireBlock(position);
    await this.#approach(position, options.signal);
    await this.#inventory.equip(item, "hand", options);
    throwIfAborted(options.signal);
    this.#changes.expectChange(position);
    this.#changes.expectChange(offset(position, "up"));
    if (AIM_AND_USE_ITEMS.has(item)) {
      // Buckets act on the block the player looks at: aim at the top face, then use the item.
      const topFace = new Vec3(position.x + 0.5, position.y + 1, position.z + 0.5);
      await this.#guard("aiming", options.signal, () => this.#bot.lookAt(topFace, true));
      this.#bot.activateItem();
      await sleep(150, options.signal);
      this.#bot.deactivateItem();
    } else {
      await this.#guard(`using ${item} on ${block.name}`, options.signal, () =>
        this.#bot.activateBlock(block, new Vec3(0, 1, 0)),
      );
    }
    await sleep(300, options.signal);
    return this.#readBack(position);
  }

  /** Eats or drinks an item. */
  async consume(itemName: string, options: ActionOptions = {}): Promise<void> {
    const item = requireItemName(this.#mcData, itemName);
    await this.#inventory.equip(item, "hand", options);
    await this.#guard(`consuming ${item}`, options.signal, () => this.#bot.consume());
  }

  /** Attacks the nearest matching entity until it is gone or the time runs out. */
  async attack(
    target: string,
    options: ActionOptions & { readonly range?: number; readonly timeoutMs?: number } = {},
  ): Promise<string> {
    const wanted = target.toLowerCase();
    const range = options.range ?? 16;
    const entity = this.#bot.nearestEntity(
      (candidate) =>
        candidate !== this.#bot.entity &&
        candidate.position.distanceTo(this.#bot.entity.position) <= range &&
        [candidate.name, candidate.username, candidate.displayName].some((name) => name?.toLowerCase() === wanted),
    );
    if (entity === null) {
      throw new ActionError(`No ${target} within ${range} blocks.`);
    }
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    let hits = 0;
    while (entity.isValid && Date.now() < deadline) {
      throwIfAborted(options.signal);
      if (entity.position.distanceTo(this.#bot.entity.position) > 3) {
        const at = entity.position.floored();
        await this.#navigator.goTo(
          { x: at.x, y: at.y, z: at.z },
          { range: 2, timeoutMs: 10_000, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
      }
      await this.#bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true);
      this.#bot.attack(entity);
      hits += 1;
      await sleep(ATTACK_COOLDOWN_MS, options.signal);
    }
    return entity.isValid
      ? `${target} survived ${hits} hits within the time limit.`
      : `${target} defeated after ${hits} hits.`;
  }

  #requireBlock(position: BlockPosition): NonNullable<ReturnType<Bot["blockAt"]>> {
    const block = this.#bot.blockAt(toVec3(position), false);
    if (block === null) {
      throw new ActionError(`The chunk at ${formatPosition(position)} is not loaded; move closer first.`);
    }
    return block;
  }

  async #approach(position: BlockPosition, signal: AbortSignal | undefined): Promise<void> {
    const eye = this.#bot.entity.position.offset(0, EYE_HEIGHT, 0);
    if (distance(eye, blockCenter(position)) <= REACH) {
      return;
    }
    await this.#navigator.goTo(position, { range: 3, ...(signal === undefined ? {} : { signal }) });
  }

  async #guard(label: string, signal: AbortSignal | undefined, operation: () => Promise<void>): Promise<void> {
    try {
      await runWithLimits(operation, { signal, timeoutMs: 10_000, label });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ActionError(`${label} failed: ${errorMessage(error)}.`, { cause: error });
    }
  }

  #readBack(position: BlockPosition): BlockState {
    const block = this.#bot.blockAt(toVec3(position), false);
    return block === null ? { name: "unknown", properties: {} } : blockStateOf(block);
  }
}
