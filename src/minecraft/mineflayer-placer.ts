import type { IndexedData } from "minecraft-data";
import type { Bot, PlaceBlockOptions } from "mineflayer";
import pathfinderPackage, { type GoalPlaceBlockOptions } from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

import { runWithLimits, sleep, throwIfAborted } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";
import type {
  BlockChangeRecorder,
  BlockPlacer,
  InventoryManager,
  Navigator,
  PlaceOptions,
  PlaceResult,
} from "./game-services.ts";
import { blockCenter, distance, FACE_OFFSETS, offset, opposite, toVec3 } from "./geometry.ts";
import { blockStateOf, placedBlockName, REPLACEABLE_BLOCKS, requireItemName } from "./names.ts";
import { pathfind } from "./pathfinder-navigator.ts";
import { formatPosition, isAir, type BlockPosition, type Direction } from "./types.ts";

const { goals } = pathfinderPackage;

/** Players reach blocks up to 4.5 blocks from the eyes in survival (5 in creative); stay a little inside. */
const REACH = 4.3;
const EYE_HEIGHT = 1.62;
const PLACE_TIMEOUT_MS = 8_000;
const APPROACH_TIMEOUT_MS = 45_000;

/** Neighbours to try as the block to place against, best first: the ground below, then the sides, then above. */
const REFERENCE_ORDER: readonly Direction[] = ["down", "north", "south", "east", "west", "up"];
/** Blocks that hang on the side of another block, so they are placed against a side, never the ground. */
const WALL_MOUNTED = /^(ladder)$/;

/**
 * Blocks whose `facing` points back at the player who placed them. All other directional blocks
 * (stairs, doors, gates, beds, trapdoors) face the way the player looks.
 */
const FACES_PLAYER =
  /(chest|furnace|smoker|carved_pumpkin|jack_o_lantern|barrel|dispenser|dropper|observer|piston|lectern|loom|beehive|bee_nest|stonecutter|grindstone|anvil|campfire|end_portal_frame|repeater|comparator|_bed$)/;

/** {@link BlockPlacer} for a Mineflayer bot: approach, equip, click a neighbouring face, verify. */
export class MineflayerPlacer implements BlockPlacer {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;
  readonly #navigator: Navigator;
  readonly #inventory: InventoryManager;
  readonly #changes: BlockChangeRecorder;

  /**
   * @param bot - A spawned bot with the pathfinder plugin loaded.
   * @param mcData - Data for the server's version.
   * @param navigator - Used to walk into reach.
   * @param inventory - Used to equip the item.
   * @param changes - Told about the placement so the change is attributed to the bot.
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

  /** Places `itemName` at `target` and verifies it by reading the block back. */
  async place(target: BlockPosition, itemName: string, options: PlaceOptions = {}): Promise<PlaceResult> {
    const item = requireItemName(this.#mcData, itemName);
    const expectedBlock = placedBlockName(item);
    const current = this.#blockAt(target);
    if (current.name === expectedBlock) {
      return { position: target, block: blockStateOf(current), against: null, alreadyPresent: true, warning: null };
    }
    if (!REPLACEABLE_BLOCKS.has(current.name)) {
      throw new ActionError(
        `${formatPosition(target)} is occupied by ${current.name}. Dig it first, or choose another position.`,
      );
    }
    if (this.#mcData.blocksByName[expectedBlock] === undefined) {
      throw new ActionError(
        `${item} is not a placeable block. Use use_item_on for items such as buckets or bone meal.`,
      );
    }
    const wallFacing = WALL_MOUNTED.test(expectedBlock) ? (options.facing ?? null) : undefined;
    const reference = this.#chooseReference(target, options.half, wallFacing);
    if (reference === null) {
      throw new ActionError(
        `Nothing solid next to ${formatPosition(target)} to place against. Place a supporting block below or beside it first.`,
      );
    }

    if (options.approach !== false) {
      await this.#approach(target, options.signal);
    }
    this.#assertReachable(target);
    this.#assertNotInside(target);
    await this.#inventory.equip(item, "hand", options);
    throwIfAborted(options.signal);

    const lookDirection = options.facing === undefined ? undefined : lookDirectionFor(expectedBlock, options.facing);
    if (lookDirection !== undefined) {
      await this.#navigator.face(lookDirection, options);
    }
    this.#changes.expectChange(target);
    const placeError = await this.#click(reference.block, reference.face, options, lookDirection !== undefined);

    const after = await this.#readBackChange(target, current.name);
    if (after === null) {
      const reason = placeError === null ? "the block did not change" : errorMessage(placeError);
      throw new ActionError(`Could not place ${item} at ${formatPosition(target)}: ${reason}.`);
    }
    const state = blockStateOf(after);
    return {
      position: target,
      block: state,
      against: reference.position,
      alreadyPresent: false,
      warning: facingWarning(options.facing, state.properties.facing),
    };
  }

  #blockAt(position: BlockPosition): Block {
    const block = this.#bot.blockAt(toVec3(position), false);
    if (block === null) {
      throw new ActionError(`The chunk at ${formatPosition(position)} is not loaded; move closer first.`);
    }
    return block;
  }

  /**
   * The neighbour to click and the face of it to click, or null when every neighbour is air or fluid.
   *
   * @param wallFacing - For wall-mounted blocks such as ladders: null to use any side, or the way the
   *   block should face, which puts it on the wall behind. Undefined for every other block.
   */
  #chooseReference(
    target: BlockPosition,
    half: PlaceOptions["half"],
    wallFacing?: Direction | null,
  ): { block: Block; face: Vec3; position: BlockPosition } | null {
    let order: readonly Direction[] =
      half === "top" ? ["up", "north", "south", "east", "west", "down"] : REFERENCE_ORDER;
    if (wallFacing !== undefined) {
      order =
        wallFacing === null || wallFacing === "up" || wallFacing === "down"
          ? ["north", "south", "east", "west"]
          : [opposite(wallFacing)];
    }
    for (const side of order) {
      const position = offset(target, side);
      const block = this.#bot.blockAt(toVec3(position), false);
      if (block === null || REPLACEABLE_BLOCKS.has(block.name) || block.boundingBox !== "block") {
        continue;
      }
      const toward = FACE_OFFSETS[opposite(side)];
      return { block, face: new Vec3(toward.x, toward.y, toward.z), position };
    }
    return null;
  }

  async #approach(target: BlockPosition, signal: AbortSignal | undefined): Promise<void> {
    if (this.#eyeDistance(target) <= REACH && !this.#standsIn(target)) {
      return;
    }
    const goal = new goals.GoalPlaceBlock(toVec3(target), this.#bot.world, {
      range: REACH,
      LOS: false,
    } as GoalPlaceBlockOptions);
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

  #assertReachable(target: BlockPosition): void {
    const reach = this.#eyeDistance(target);
    if (reach > REACH + 0.7) {
      throw new ActionError(
        `${formatPosition(target)} is ${reach.toFixed(1)} blocks away, out of reach. Move closer first.`,
      );
    }
  }

  #assertNotInside(target: BlockPosition): void {
    if (this.#standsIn(target)) {
      throw new ActionError(`The bot is standing in ${formatPosition(target)}; move out of the way first.`);
    }
  }

  async #click(reference: Block, face: Vec3, options: PlaceOptions, keepLook: boolean): Promise<unknown> {
    const placeOptions: PlaceBlockOptions = {
      half: options.half,
      swingArm: "right",
      forceLook: keepLook ? "ignore" : true,
    };
    try {
      await runWithLimits(() => this.#bot._placeBlockWithOptions(reference, face, placeOptions), {
        signal: options.signal,
        timeoutMs: PLACE_TIMEOUT_MS,
        label: "placing",
      });
      return null;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      // Mineflayer can report failure even when the server placed the block; the caller reads it back.
      return error;
    }
  }

  /** The block at `target` once it differs from `beforeName`, or null if it has not changed within a second. */
  async #readBackChange(target: BlockPosition, beforeName: string): Promise<Block | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const block = this.#bot.blockAt(toVec3(target), false);
      if (block !== null && block.name !== beforeName && !isAir(block.name)) {
        return block;
      }
      await sleep(100);
    }
    return null;
  }

  #eyeDistance(target: BlockPosition): number {
    const eye = this.#bot.entity.position.offset(0, EYE_HEIGHT, 0);
    return distance(eye, blockCenter(target));
  }

  /** True when the bot's 0.6 x 1.8 hitbox overlaps the target cell. */
  #standsIn(target: BlockPosition): boolean {
    const feet = this.#bot.entity.position;
    const overlapsX = feet.x + 0.3 > target.x && feet.x - 0.3 < target.x + 1;
    const overlapsZ = feet.z + 0.3 > target.z && feet.z - 0.3 < target.z + 1;
    const overlapsY = feet.y + 1.8 > target.y && feet.y < target.y + 1;
    return overlapsX && overlapsY && overlapsZ;
  }
}

/** The direction the bot must look so that `blockName` ends up facing `facing`. */
function lookDirectionFor(blockName: string, facing: Direction): Direction | undefined {
  if (facing === "up" || facing === "down") {
    return undefined;
  }
  return FACES_PLAYER.test(blockName) ? opposite(facing) : facing;
}

function facingWarning(requested: Direction | undefined, actual: string | undefined): string | null {
  if (requested === undefined || actual === undefined || requested === actual) {
    return null;
  }
  return `Requested facing ${requested}, but the block faces ${actual}.`;
}
