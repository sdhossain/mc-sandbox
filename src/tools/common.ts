/** Argument schemas and output formatting shared by the tools. */

import { z } from "zod";

import { boxFromCorners, formatPosition, type BlockPosition, type Box, type ItemCount } from "../minecraft/types.ts";

/** An integer block coordinate. */
export const coordinate = (axis: "x" | "y" | "z"): z.ZodInt => z.int().describe(`Block ${axis} coordinate (absolute).`);

/** `x`, `y`, `z` of one block. */
export const positionShape = { x: coordinate("x"), y: coordinate("y"), z: coordinate("z") };

/** Two corners of a box, any order. */
export const boxShape = {
  x1: z.int().describe("First corner x."),
  y1: z.int().describe("First corner y."),
  z1: z.int().describe("First corner z."),
  x2: z.int().describe("Opposite corner x."),
  y2: z.int().describe("Opposite corner y."),
  z2: z.int().describe("Opposite corner z."),
};

/** A horizontal or vertical facing. */
export const directionSchema = z.enum(["north", "south", "east", "west", "up", "down"]);

/** The position in validated `x`, `y`, `z` arguments. */
export function positionOf(args: { readonly x: number; readonly y: number; readonly z: number }): BlockPosition {
  return { x: args.x, y: args.y, z: args.z };
}

/** The box spanned by validated corner arguments. */
export function boxOf(args: {
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  readonly x2: number;
  readonly y2: number;
  readonly z2: number;
}): Box {
  return boxFromCorners({ x: args.x1, y: args.y1, z: args.z1 }, { x: args.x2, y: args.y2, z: args.z2 });
}

/** Formats items as `3 oak_log, 12 dirt`, or `nothing`. */
export function formatItems(items: readonly ItemCount[]): string {
  return items.length === 0 ? "nothing" : items.map((item) => `${item.count} ${item.name}`).join(", ");
}

/** Formats a list of positions, capped, for example `(1, 64, 2), (3, 64, 2) and 5 more`. */
export function formatPositions(positions: readonly BlockPosition[], limit = 20): string {
  const shown = positions.slice(0, limit).map(formatPosition).join(", ");
  return positions.length > limit ? `${shown} and ${positions.length - limit} more` : shown;
}

/** The argument value, or `fallback` when the model passed null. */
export function orDefault<T>(value: T | null, fallback: T): T {
  return value ?? fallback;
}
