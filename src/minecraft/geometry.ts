/**
 * Conversions between the lab's plain position types and Mineflayer's `Vec3`, plus direction maths.
 */

import { Vec3 } from "vec3";

import type { BlockPosition, Direction, Position } from "./types.ts";

/** Converts a plain position to a `Vec3`. */
export function toVec3(position: Position): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

/** Converts a `Vec3` (or any x/y/z object) to the block position that contains it. */
export function toBlockPosition(point: Position): BlockPosition {
  return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
}

/** Converts a `Vec3` to a plain position object, rounded to two decimals. */
export function toPosition(point: Position): Position {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return { x: round(point.x), y: round(point.y), z: round(point.z) };
}

/** The centre of a block. */
export function blockCenter(position: BlockPosition): Vec3 {
  return new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5);
}

/** Euclidean distance between two points. */
export function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** True when two block positions are the same block. */
export function samePosition(a: BlockPosition, b: BlockPosition): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Unit offsets of the six faces. */
export const FACE_OFFSETS: Readonly<Record<Direction, BlockPosition>> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};

/** The position next to `position` across `face`. */
export function offset(position: BlockPosition, face: Direction): BlockPosition {
  const delta = FACE_OFFSETS[face];
  return { x: position.x + delta.x, y: position.y + delta.y, z: position.z + delta.z };
}

/** The opposite direction. */
export function opposite(direction: Direction): Direction {
  const opposites: Record<Direction, Direction> = {
    up: "down",
    down: "up",
    north: "south",
    south: "north",
    east: "west",
    west: "east",
  };
  return opposites[direction];
}

/**
 * Mineflayer yaw, in radians, for facing a horizontal direction.
 *
 * Mineflayer measures yaw counter-clockwise from north (-z): north 0, west π/2, south π, east -π/2.
 */
export function yawFor(direction: Direction): number {
  const yaws: Partial<Record<Direction, number>> = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
  const yaw = yaws[direction];
  if (yaw === undefined) {
    throw new RangeError(`"${direction}" is not a horizontal direction`);
  }
  return yaw;
}

/** The horizontal direction closest to a Mineflayer yaw. */
export function directionFromYaw(yaw: number): Direction {
  const turn = Math.PI * 2;
  const normalised = ((yaw % turn) + turn) % turn;
  const index = Math.round(normalised / (Math.PI / 2)) % 4;
  const byIndex: readonly Direction[] = ["north", "west", "south", "east"];
  return byIndex[index] ?? "north";
}
