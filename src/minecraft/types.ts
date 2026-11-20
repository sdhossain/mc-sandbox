/**
 * Plain value types for positions, blocks, items and entities.
 *
 * These cross every boundary in the lab (tools, events, snapshots, the dashboard), so they are plain
 * JSON-serialisable objects, never Mineflayer or Vec3 instances.
 *
 * Coordinates are Minecraft world coordinates as F3 shows them: x points east, y up, z south.
 */

/** An integer block position. */
export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A position that may be fractional, such as an entity's feet. */
export type Position = BlockPosition;

/** An axis-aligned box of block positions, inclusive on both corners. `min` <= `max` on every axis. */
export interface Box {
  readonly min: BlockPosition;
  readonly max: BlockPosition;
}

/** The six faces of a block. */
export const Direction = {
  UP: "up",
  DOWN: "down",
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** A block's name (without the `minecraft:` prefix) and its block-state properties, all values as strings. */
export interface BlockState {
  readonly name: string;
  readonly properties: Readonly<Record<string, string>>;
}

/** An item name and a count. */
export interface ItemCount {
  readonly name: string;
  readonly count: number;
}

/** One inventory slot. */
export interface InventorySlot extends ItemCount {
  /** Mineflayer window slot index. */
  readonly slot: number;
}

/** What the bot can see of another entity. */
export interface EntityInfo {
  readonly id: number;
  /** Entity type, for example `zombie`, `item` or `player`. */
  readonly type: string;
  /** Player name for players, item name for dropped items, display name otherwise. */
  readonly name: string;
  readonly position: Position;
  readonly distance: number;
}

/** A player the bot knows about. `position` is null when the player is out of the bot's view range. */
export interface PlayerInfo {
  readonly username: string;
  readonly position: Position | null;
  /** Horizontal facing, from the player's yaw. Null when out of view. */
  readonly facing: Direction | null;
  /** The block the player's crosshair is on, within 6 blocks. Null when none or out of view. */
  readonly lookingAt: (BlockState & { readonly position: BlockPosition }) | null;
  readonly gameMode: string | null;
}

/** The bot's own condition. */
export interface BotStatus {
  readonly username: string;
  readonly position: Position;
  /** Horizontal facing, from the bot's yaw. */
  readonly facing: Direction;
  readonly health: number;
  readonly food: number;
  readonly gameMode: string;
  readonly dimension: string;
  /** Time of day in ticks, 0 to 23999, where 0 is sunrise. */
  readonly timeOfDay: number;
  readonly isRaining: boolean;
  readonly heldItem: string | null;
  readonly onGround: boolean;
  /** Number of empty inventory slots out of 36. */
  readonly freeSlots: number;
}

/** Who caused a block change, as far as the lab can tell. */
export const ChangeCause = {
  /** The change matches an action this bot just took at that position. */
  BOT: "bot",
  /** Anything else: the owner, another bot, mobs, physics, fluids. */
  OTHER: "other",
} as const;
export type ChangeCause = (typeof ChangeCause)[keyof typeof ChangeCause];

/** One observed block change. */
export interface BlockChange {
  /** Position in the recorder's log, increasing from 1. */
  readonly seq: number;
  /** Wall-clock time, milliseconds since the Unix epoch. */
  readonly timeMs: number;
  /** World age in ticks when the change was seen. */
  readonly gameTick: number;
  readonly position: BlockPosition;
  /** The block before the change; null when the chunk had not been seen before. */
  readonly before: BlockState | null;
  readonly after: BlockState;
  readonly cause: ChangeCause;
}

/**
 * The non-air blocks in a box at one moment, in the `mclab.snapshot.v1` format.
 *
 * `blocks` rows are `[x, y, z, name, properties]` in world coordinates.
 */
export interface RegionSnapshot {
  readonly schema: "mclab.snapshot.v1";
  readonly box: Box;
  readonly takenAtMs: number;
  readonly gameTick: number;
  /** Cells in the box whose chunk was not loaded; their contents are unknown. */
  readonly unloadedCells: number;
  readonly blocks: readonly SnapshotRow[];
}

/** One row of a {@link RegionSnapshot}: `[x, y, z, name, properties]`. */
export type SnapshotRow = readonly [number, number, number, string, Readonly<Record<string, string>>];

/** Returns the number of cells in `box`. */
export function boxVolume(box: Box): number {
  return (box.max.x - box.min.x + 1) * (box.max.y - box.min.y + 1) * (box.max.z - box.min.z + 1);
}

/** Returns the box spanning two corners given in any order. */
export function boxFromCorners(a: BlockPosition, b: BlockPosition): Box {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

/** Formats a position as `(x, y, z)`, rounding fractional coordinates to one decimal. */
export function formatPosition(position: Position): string {
  const round = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `(${round(position.x)}, ${round(position.y)}, ${round(position.z)})`;
}

/** Formats a block state as Minecraft's `name[key=value,...]` syntax. */
export function formatBlockState(state: BlockState): string {
  const entries = Object.entries(state.properties);
  if (entries.length === 0) {
    return state.name;
  }
  return `${state.name}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

/** Returns true for the block names that mean "nothing here". */
export function isAir(name: string): boolean {
  return name === "air" || name === "cave_air" || name === "void_air";
}
