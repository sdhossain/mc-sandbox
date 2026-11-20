/**
 * The contracts of the game layer: what tools, skills and model-written code can ask the bot to do.
 *
 * Each service wraps one area of Mineflayer and makes it robust and observable. Conventions:
 * - Methods that act take an optional `signal`; aborting it stops the bot and rejects with `AbortedError`.
 * - An action that cannot be carried out throws `ActionError` with a message the model can act on, for
 *   example "No path to (10, 64, -3): target is inside a solid block". Success returns a result object.
 * - Positions are plain {@link BlockPosition} objects; item and block names have no `minecraft:` prefix.
 */

import type { Bot } from "mineflayer";
import type { IndexedData } from "minecraft-data";

import type {
  BlockPosition,
  BlockState,
  BotStatus,
  Box,
  BlockChange,
  Direction,
  EntityInfo,
  InventorySlot,
  ItemCount,
  PlayerInfo,
  Position,
  RegionSnapshot,
} from "./types.ts";

/** Options shared by every action. */
export interface ActionOptions {
  /** Aborts the action and stops the bot. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------------------------------
// Movement

/** Options for {@link Navigator.goTo}. */
export interface GoToOptions extends ActionOptions {
  /** Stop when within this many blocks of the target. 0 means stand on the target block. Default 1. */
  readonly range?: number;
  /** Give up after this long. Default 60 s. */
  readonly timeoutMs?: number;
}

/** Where a movement ended. */
export interface MoveResult {
  /** The bot's feet position after moving. */
  readonly position: Position;
  /** Straight-line distance from the bot to the target after moving. */
  readonly distance: number;
  readonly durationMs: number;
}

/** Walks the bot with pathfinding (mineflayer-pathfinder). */
export interface Navigator {
  /** Walks to within `range` blocks of `target`. Throws `ActionError` when no path is found or the bot gets stuck. */
  goTo(target: BlockPosition, options?: GoToOptions): Promise<MoveResult>;
  /** Walks to within `range` blocks of a player. Throws `ActionError` when the player is not in view. */
  goToPlayer(username: string, options?: GoToOptions): Promise<MoveResult>;
  /** Turns the bot's head to look at a point (block centre for block positions). */
  lookAt(target: Position, options?: ActionOptions): Promise<void>;
  /** Turns the bot to face a horizontal direction, level with the horizon. */
  face(direction: Direction, options?: ActionOptions): Promise<void>;
  /** Stops any movement in progress. */
  stop(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Building

/** Options for {@link BlockPlacer.place}. */
export interface PlaceOptions extends ActionOptions {
  /**
   * Horizontal direction the placed block should face, for directional blocks (stairs, doors, chests,
   * furnaces). The bot turns this way before placing, as a player would.
   */
  readonly facing?: Direction;
  /** For stairs, slabs and trapdoors: place in the top or bottom half. */
  readonly half?: "top" | "bottom";
  /** Walk into reach first when the target is too far. Default true. */
  readonly approach?: boolean;
}

/** A completed placement. */
export interface PlaceResult {
  readonly position: BlockPosition;
  /** The block now at the position, as read back from the world. */
  readonly block: BlockState;
  /** The block this one was placed against; null when the block was already there. */
  readonly against: BlockPosition | null;
  /** True when the requested block was already at the position, so nothing was placed. */
  readonly alreadyPresent: boolean;
  /** A note for the model when the result differs from the request, for example a different facing. */
  readonly warning: string | null;
}

/** Places blocks the way a player does: hold the item, look at a neighbouring face, click. */
export interface BlockPlacer {
  /**
   * Places `itemName` at `target` and verifies the result by reading the block back.
   *
   * In creative mode the item is taken from the creative inventory when the bot has none. In survival
   * the bot must carry it. Throws `ActionError` when the target is occupied, nothing solid is adjacent
   * to place against, the item is missing, or the server rejects the placement.
   */
  place(target: BlockPosition, itemName: string, options?: PlaceOptions): Promise<PlaceResult>;
}

/** Options for {@link BlockBreaker.dig}. */
export interface DigOptions extends ActionOptions {
  /** Walk into reach first when the target is too far. Default true. */
  readonly approach?: boolean;
  /** Walk over the dropped item afterwards to pick it up. Default true in survival, false in creative. */
  readonly collectDrops?: boolean;
}

/** A completed dig. */
export interface DigResult {
  readonly position: BlockPosition;
  /** The block that was broken. */
  readonly broken: BlockState;
  /** The tool equipped for digging, null for bare hands. */
  readonly tool: string | null;
  /** Items that entered the inventory while digging and collecting. */
  readonly collected: readonly ItemCount[];
  /** A note for the model, for example that the block drops nothing without a better tool. */
  readonly warning: string | null;
}

/** Breaks blocks, choosing the best tool in the inventory. */
export interface BlockBreaker {
  /** Breaks the block at `target` and verifies it is gone. Throws `ActionError` for air, unbreakable or unreachable blocks. */
  dig(target: BlockPosition, options?: DigOptions): Promise<DigResult>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inventory, crafting, containers, interaction

/** Equipment slots. */
export type EquipSlot = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

/** Reads and rearranges the bot's inventory. */
export interface InventoryManager {
  /** Every occupied slot. */
  slots(): InventorySlot[];
  /** Items summed by name, most numerous first. */
  totals(): ItemCount[];
  /** How many of `itemName` the bot carries. */
  count(itemName: string): number;
  /** The item in the main hand, or null. */
  heldItem(): string | null;
  /** Number of empty slots out of 36. */
  freeSlots(): number;
  /** Equips an item the bot carries. In creative mode a missing item is taken from the creative inventory. */
  equip(itemName: string, slot?: EquipSlot, options?: ActionOptions): Promise<void>;
  /** Drops `count` of an item (all of it when omitted). Returns the number dropped. */
  toss(itemName: string, count?: number, options?: ActionOptions): Promise<number>;
  /** Creative mode only: puts `count` of an item into the inventory. Throws `ActionError` in other modes. */
  giveCreative(itemName: string, count: number, options?: ActionOptions): Promise<void>;
}

/** A completed craft or smelt. */
export interface CraftResult {
  readonly item: string;
  /** Number of items produced. */
  readonly produced: number;
  /** Ingredients consumed. */
  readonly consumed: readonly ItemCount[];
  /** Where the crafting table or furnace was, if one was used. */
  readonly station: BlockPosition | null;
}

/** Crafts single recipes and smelts items. Multi-level crafting (logs to planks to sticks) is a skill. */
export interface Crafter {
  /**
   * Crafts `count` of `itemName` from one recipe, using a crafting table within 32 blocks when the
   * recipe needs one. Throws `ActionError` naming the missing ingredients or the missing table.
   */
  craft(itemName: string, count: number, options?: ActionOptions): Promise<CraftResult>;
  /** Ingredients missing to craft `count` of `itemName` with the best recipe; null when no recipe exists. */
  missingIngredients(itemName: string, count: number): ItemCount[] | null;
  /** Smelts `count` items in a furnace within 32 blocks, adding `fuelName` as needed, and collects the output. */
  smelt(itemName: string, fuelName: string, count: number, options?: ActionOptions): Promise<CraftResult>;
}

/** Reads and moves items in chests, barrels and other containers. */
export interface ContainerHandler {
  /** What the container at `position` holds. Walks into reach first. */
  contents(position: BlockPosition, options?: ActionOptions): Promise<ItemCount[]>;
  /** Puts items into the container. Returns the number moved. */
  deposit(position: BlockPosition, itemName: string, count?: number, options?: ActionOptions): Promise<number>;
  /** Takes items out of the container. Returns the number moved. */
  withdraw(position: BlockPosition, itemName: string, count?: number, options?: ActionOptions): Promise<number>;
}

/** Right-click interactions and combat. */
export interface Interactor {
  /** Right-clicks a block with whatever is held: opens doors and gates, presses buttons, flips levers. */
  activateBlock(position: BlockPosition, options?: ActionOptions): Promise<BlockState>;
  /**
   * Holds `itemName` and right-clicks the block at `position` with it: a hoe tills, seeds plant, a water
   * bucket pours, bone meal grows. Returns the block afterwards so the caller can see the effect.
   */
  useItemOn(position: BlockPosition, itemName: string, options?: ActionOptions): Promise<BlockState>;
  /** Eats or drinks an item from the inventory. */
  consume(itemName: string, options?: ActionOptions): Promise<void>;
  /** Attacks the nearest entity of a type or name within `range` blocks until it dies or `timeoutMs` passes. */
  attack(
    target: string,
    options?: ActionOptions & { readonly range?: number; readonly timeoutMs?: number },
  ): Promise<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Perception

/** Options for {@link WorldScanner.findBlocks}. */
export interface FindBlocksOptions {
  /** Search radius in blocks. Default 32, maximum 128. */
  readonly maxDistance?: number;
  /** Maximum number of results. Default 20. */
  readonly count?: number;
}

/** Reads the world as the bot's client knows it. Synchronous: nothing here moves the bot. */
export interface WorldScanner {
  /** The bot's own condition. */
  status(): BotStatus;
  /** The block at `position`, or null when its chunk is not loaded. */
  blockAt(position: BlockPosition): BlockState | null;
  /** Positions of blocks with any of the given names, nearest first. */
  findBlocks(names: readonly string[], options?: FindBlocksOptions): BlockPosition[];
  /** Entities within `maxDistance` blocks, nearest first, excluding the bot. */
  entities(maxDistance?: number): EntityInfo[];
  /** All online players other than the bot, with position and gaze when in view. */
  players(): PlayerInfo[];
  /** One player, or null when not online. */
  player(username: string): PlayerInfo | null;
  /** The non-air blocks in `box`. Throws `ActionError` when the box exceeds `maxCells` (default 65,536). */
  snapshot(box: Box, maxCells?: number): RegionSnapshot;
}

/** Options for {@link RegionRenderer.render}. */
export interface RenderOptions {
  /** Refuse boxes with more cells than this. Default 8,192. */
  readonly maxCells?: number;
}

/**
 * Renders a box of blocks as text for the model: one grid per y layer, bottom layer first, with
 * absolute coordinates on every row and column and a legend of one-character symbols.
 */
export interface RegionRenderer {
  /** Renders `box`. Throws `ActionError` when the box is too large; the message suggests a split. */
  render(box: Box, options?: RenderOptions): string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chat and world changes

/** A chat line from another player. */
export interface ChatMessage {
  readonly username: string;
  readonly text: string;
  /** True for a private message (`/msg`, `/tell`, `/w`) sent to this bot. */
  readonly whisper: boolean;
  readonly receivedAtMs: number;
}

/** Sends and receives chat, within the server's length and rate limits. */
export interface ChatChannel {
  /** Says `text` in public chat, split into lines of at most 256 characters and paced to avoid the spam kick. */
  say(text: string): Promise<void>;
  /** Sends a private message. */
  whisper(username: string, text: string): Promise<void>;
  /** Registers a listener for chat from other players. Returns a function that removes it. */
  onMessage(listener: (message: ChatMessage) => void): () => void;
}

/** Records every block change the bot's client sees, and which ones the bot caused. */
export interface BlockChangeRecorder {
  /** The sequence number of the newest change, 0 when none yet. Use as a bookmark for {@link since}. */
  lastSeq(): number;
  /** Changes after `seq`, optionally only those inside `box`. */
  since(seq: number, box?: Box): BlockChange[];
  /** Registers a listener for each new change. Returns a function that removes it. */
  onChange(listener: (change: BlockChange) => void): () => void;
  /** Tells the recorder the bot is about to change `position`, so the change is attributed to the bot. */
  expectChange(position: BlockPosition): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aggregate

/** Everything the game layer offers for one connected bot. */
export interface GameServices {
  /** The raw Mineflayer bot, for the code harness. Tools use the services below instead. */
  readonly bot: Bot;
  /** Block, item and recipe data for the server's version. */
  readonly mcData: IndexedData;
  readonly navigator: Navigator;
  readonly placer: BlockPlacer;
  readonly breaker: BlockBreaker;
  readonly inventory: InventoryManager;
  readonly crafter: Crafter;
  readonly containers: ContainerHandler;
  readonly interactor: Interactor;
  readonly scanner: WorldScanner;
  readonly renderer: RegionRenderer;
  readonly chat: ChatChannel;
  readonly changes: BlockChangeRecorder;
}
