/**
 * Validation of block and item names against minecraft-data, with suggestions for near misses.
 *
 * Models often invent names (`wood_planks`, `grass`); every tool checks names here first so the model
 * gets a correction instead of a silent failure.
 */

import type { IndexedData } from "minecraft-data";
import type { Block } from "prismarine-block";

import { ActionError } from "../utils/errors.ts";
import type { BlockState } from "./types.ts";

/** Removes a leading `minecraft:` and normalises case and spaces. */
export function normaliseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/[\s-]+/g, "_");
}

/** Returns the normalised item name, or throws `ActionError` with suggestions when it is unknown. */
export function requireItemName(mcData: IndexedData, name: string): string {
  const normalised = normaliseName(name);
  if (mcData.itemsByName[normalised] !== undefined) {
    return normalised;
  }
  throw new ActionError(`Unknown item "${name}".${suggestionText(normalised, Object.keys(mcData.itemsByName))}`);
}

/** Returns the normalised block name, or throws `ActionError` with suggestions when it is unknown. */
export function requireBlockName(mcData: IndexedData, name: string): string {
  const normalised = normaliseName(name);
  if (mcData.blocksByName[normalised] !== undefined) {
    return normalised;
  }
  throw new ActionError(`Unknown block "${name}".${suggestionText(normalised, Object.keys(mcData.blocksByName))}`);
}

/** Up to `limit` known names closest to `name`, by shared words and edit distance. */
export function suggestNames(name: string, known: readonly string[], limit = 3): string[] {
  const words = new Set(name.split("_"));
  return known
    .map((candidate) => {
      const shared = candidate.split("_").filter((word) => words.has(word)).length;
      return { candidate, score: editDistance(name, candidate) - shared * 3 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * True for blocks that hide what is behind them: opaque blocks whose shape is a full cube. Glass,
 * leaves, fences, stairs and slabs let you see past them.
 */
export function isOccludingBlock(mcData: IndexedData, name: string): boolean {
  const block = mcData.blocksByName[name];
  const shapes = mcData.blockCollisionShapes as
    { blocks: Record<string, number | number[]>; shapes: Record<number, number[][]> } | undefined;
  if (block === undefined || block.transparent || shapes === undefined) {
    return false;
  }
  const ids = shapes.blocks[name];
  const list = Array.isArray(ids) ? ids : [ids];
  return list.every((id) => {
    const boxes = id === undefined ? undefined : shapes.shapes[id];
    return boxes?.length === 1 && boxes[0]?.join(",") === "0,0,0,1,1,1";
  });
}

/** The block state of a prismarine block, with property values as strings. */
export function blockStateOf(block: Block): BlockState {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(block.getProperties())) {
    properties[key] = String(value);
  }
  return { name: block.name, properties };
}

/**
 * Blocks a placement can replace, as in vanilla: air, fluids, and plants or layers that break when a
 * block is placed into their cell.
 */
export const REPLACEABLE_BLOCKS: ReadonlySet<string> = new Set([
  "air",
  "cave_air",
  "void_air",
  "water",
  "lava",
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "seagrass",
  "tall_seagrass",
  "vine",
  "glow_lichen",
  "fire",
  "soul_fire",
  "snow",
  "light",
  "structure_void",
  "bubble_column",
  "crimson_roots",
  "warped_roots",
  "nether_sprouts",
  "hanging_roots",
  "short_dry_grass",
  "tall_dry_grass",
  "bush",
  "leaf_litter",
]);

/** Item names whose placed block has a different name. */
export const PLACED_BLOCK_NAMES: Readonly<Record<string, string>> = {
  wheat_seeds: "wheat",
  carrot: "carrots",
  potato: "potatoes",
  beetroot_seeds: "beetroots",
  melon_seeds: "melon_stem",
  pumpkin_seeds: "pumpkin_stem",
  redstone: "redstone_wire",
  string: "tripwire",
  sweet_berries: "sweet_berry_bush",
  glow_berries: "cave_vines",
  cocoa_beans: "cocoa",
  torchflower_seeds: "torchflower_crop",
  pitcher_pod: "pitcher_crop",
  water_bucket: "water",
  lava_bucket: "lava",
  powder_snow_bucket: "powder_snow",
};

/** The block name an item places, which is usually the item's own name. */
export function placedBlockName(itemName: string): string {
  return PLACED_BLOCK_NAMES[itemName] ?? itemName;
}

function suggestionText(name: string, known: readonly string[]): string {
  const suggestions = suggestNames(name, known);
  return suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}
