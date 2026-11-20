import type { GameServices } from "../minecraft/game-services.ts";
import { offset } from "../minecraft/geometry.ts";
import { normaliseName, placedBlockName, REPLACEABLE_BLOCKS, requireItemName } from "../minecraft/names.ts";
import {
  boxVolume,
  formatPosition,
  isAir,
  type BlockPosition,
  type Box,
  type Direction,
  type ItemCount,
} from "../minecraft/types.ts";
import { throwIfAborted } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";

/** Where a skill reports to and how it is stopped. */
export interface SkillScope {
  readonly signal?: AbortSignal;
  /** Reports progress, for example "placed 40 of 120 blocks". */
  progress(message: string): void;
}

/** One block of a planned structure. */
export interface PlannedBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The block item to place, for example `oak_planks`. */
  readonly block: string;
  readonly facing?: Direction | null;
  readonly half?: "top" | "bottom" | null;
}

/** A block a skill could not place or break, and why. */
export interface SkillFailure {
  readonly position: BlockPosition;
  readonly block: string;
  readonly reason: string;
}

/** The result of a build. */
export interface BuildReport {
  readonly requested: number;
  readonly placed: number;
  readonly alreadyCorrect: number;
  /** Blocks dug out because something else was in the way (only with `replace`). */
  readonly replaced: number;
  readonly failed: readonly SkillFailure[];
  readonly durationMs: number;
}

/** The result of clearing a region. */
export interface ClearReport {
  readonly removed: number;
  readonly failed: readonly SkillFailure[];
}

/** The result of gathering. */
export interface CollectReport {
  /** The item that was asked for. */
  readonly item: string;
  readonly wanted: number;
  /** The blocks that drop the item, which the skill looked for. */
  readonly sources: readonly string[];
  readonly collected: readonly ItemCount[];
  readonly blocksDug: number;
  readonly stoppedBecause: string;
}

/** The result of preparing a farm plot. */
export interface FarmReport {
  readonly tilled: number;
  readonly planted: number;
  readonly water: BlockPosition | null;
  readonly failed: readonly SkillFailure[];
}

const MAX_BUILD_BLOCKS = 4_096;
const MAX_CLEAR_CELLS = 16_384;
const MAX_CRAFT_DEPTH = 5;
const PROGRESS_EVERY = 10;

/**
 * Multi-step routines built on the game layer: building from a block list, filling and clearing
 * boxes, gathering, crafting with intermediate steps, and preparing farm plots.
 *
 * The skills harness exposes them as tools; the code harness exposes them as `skills.*` functions.
 * Each routine reports exactly what it did, including every failure, so the model can fix the rest.
 */
export class SkillLibrary {
  readonly #game: GameServices;
  readonly #scope: SkillScope;

  /**
   * @param game - The connected bot's game layer.
   * @param scope - Progress reporting and the abort signal.
   */
  constructor(game: GameServices, scope: SkillScope) {
    this.#game = game;
    this.#scope = scope;
  }

  /**
   * Places a list of blocks: lowest layer first, in a back-and-forth order that limits walking, retrying
   * blocks that had nothing to rest on once their neighbours exist.
   *
   * @param blocks - The planned blocks. Later entries win when two share a position.
   * @param replace - Dig out other blocks in the way instead of reporting them as failures.
   */
  async buildStructure(blocks: readonly PlannedBlock[], replace = false): Promise<BuildReport> {
    const started = performance.now();
    if (blocks.length > MAX_BUILD_BLOCKS) {
      throw new ActionError(`A build is limited to ${MAX_BUILD_BLOCKS} blocks; split it into parts.`);
    }
    const plan = orderForBuilding(dedupe(blocks)).map((block) => ({
      ...block,
      block: requireItemName(this.#game.mcData, block.block),
    }));
    let placed = 0;
    let alreadyCorrect = 0;
    let replaced = 0;
    const failed: SkillFailure[] = [];
    let pending = plan;
    for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
      const unsupported: typeof plan = [];
      for (const block of pending) {
        throwIfAborted(this.#scope.signal);
        const position = { x: block.x, y: block.y, z: block.z };
        const current = this.#game.scanner.blockAt(position);
        if (current?.name === placedBlockName(block.block)) {
          alreadyCorrect += 1;
          continue;
        }
        try {
          if (current !== null && !REPLACEABLE_BLOCKS.has(current.name)) {
            if (!replace) {
              failed.push({ position, block: block.block, reason: `occupied by ${current.name}` });
              continue;
            }
            await this.#game.breaker.dig(position, this.#actionOptions({ collectDrops: false }));
            replaced += 1;
          }
          const result = await this.#game.placer.place(position, block.block, {
            ...this.#actionOptions(),
            ...(block.facing === undefined || block.facing === null ? {} : { facing: block.facing }),
            ...(block.half === undefined || block.half === null ? {} : { half: block.half }),
          });
          if (result.alreadyPresent) {
            alreadyCorrect += 1;
          } else {
            placed += 1;
          }
          if ((placed + alreadyCorrect) % PROGRESS_EVERY === 0) {
            this.#scope.progress(`${placed + alreadyCorrect} of ${plan.length} blocks done`);
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          const reason = errorMessage(error);
          if (reason.includes("Nothing solid next to") && pass < 3) {
            unsupported.push(block);
          } else {
            failed.push({ position, block: block.block, reason });
          }
        }
      }
      if (unsupported.length === pending.length) {
        failed.push(
          ...unsupported.map((block) => ({
            position: { x: block.x, y: block.y, z: block.z },
            block: block.block,
            reason: "nothing to place it against",
          })),
        );
        break;
      }
      pending = unsupported;
    }
    return {
      requested: plan.length,
      placed,
      alreadyCorrect,
      replaced,
      failed,
      durationMs: Math.round(performance.now() - started),
    };
  }

  /** Fills a box with one block, or only its outer shell when `hollow`. */
  async fillRegion(box: Box, block: string, hollow = false, replace = false): Promise<BuildReport> {
    const blocks: PlannedBlock[] = [];
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      for (let z = box.min.z; z <= box.max.z; z += 1) {
        for (let x = box.min.x; x <= box.max.x; x += 1) {
          const onShell =
            x === box.min.x ||
            x === box.max.x ||
            y === box.min.y ||
            y === box.max.y ||
            z === box.min.z ||
            z === box.max.z;
          if (!hollow || onShell) {
            blocks.push({ x, y, z, block });
          }
        }
      }
    }
    return this.buildStructure(blocks, replace);
  }

  /** Breaks every block in a box, top layer first. */
  async clearRegion(box: Box): Promise<ClearReport> {
    if (boxVolume(box) > MAX_CLEAR_CELLS) {
      throw new ActionError(`Clearing is limited to ${MAX_CLEAR_CELLS} cells at a time; split the region.`);
    }
    let removed = 0;
    const failed: SkillFailure[] = [];
    for (let y = box.max.y; y >= box.min.y; y -= 1) {
      for (let z = box.min.z; z <= box.max.z; z += 1) {
        for (let x = box.min.x; x <= box.max.x; x += 1) {
          throwIfAborted(this.#scope.signal);
          const position = { x, y, z };
          const current = this.#game.scanner.blockAt(position);
          if (current === null || isAir(current.name) || current.name === "water" || current.name === "lava") {
            continue;
          }
          try {
            await this.#game.breaker.dig(position, this.#actionOptions({ collectDrops: false }));
            removed += 1;
            if (removed % PROGRESS_EVERY === 0) {
              this.#scope.progress(`${removed} blocks removed`);
            }
          } catch (error) {
            if (isAbortError(error)) {
              throw error;
            }
            failed.push({ position, block: current.name, reason: errorMessage(error) });
          }
        }
      }
    }
    return { removed, failed };
  }

  /**
   * Gathers `count` of an item by digging the blocks that drop it (dirt comes from dirt and grass
   * blocks, cobblestone from stone), walking to each and picking up the drop.
   *
   * It digs only blocks whose top face is open, so the drop lands where the bot can reach it, prefers
   * blocks at the level the bot stands on (so it does not dig pits), never digs the block under its own
   * feet, and stops after three digs in a row that pick nothing up.
   */
  async collectBlocks(item: string, count: number, maxDistance = 48): Promise<CollectReport> {
    const wanted = normaliseName(item);
    const sources = this.#sourceBlocks(wanted);
    if (sources.length === 0) {
      throw new ActionError(`No block drops ${wanted} when broken. Craft, smelt or find it instead.`);
    }
    const before = this.#counts();
    const maxDigs = count * 2 + 8;
    let blocksDug = 0;
    let digsWithoutGain = 0;
    let lastFailure: string | null = null;
    let stoppedBecause = "collected enough";
    const tried = new Set<string>();
    while (this.#gained(before) < count) {
      throwIfAborted(this.#scope.signal);
      if (blocksDug >= maxDigs) {
        stoppedBecause = `dug ${blocksDug} blocks, the limit for ${count} items`;
        break;
      }
      const next = this.#nextSource(sources, maxDistance, tried);
      if (next === null) {
        stoppedBecause = `no more ${sources.join(" or ")} with an open top within ${maxDistance} blocks`;
        break;
      }
      tried.add(`${next.x},${next.y},${next.z}`);
      const gainedBefore = this.#gained(before);
      try {
        await this.#game.breaker.dig(next, this.#actionOptions({ collectDrops: true }));
        blocksDug += 1;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        lastFailure = errorMessage(error);
      }
      digsWithoutGain = this.#gained(before) > gainedBefore ? 0 : digsWithoutGain + 1;
      this.#scope.progress(`${this.#gained(before)} of ${count} ${wanted} collected`);
      if (digsWithoutGain >= 3) {
        const why = lastFailure ?? "the drops were out of reach, or a better tool is needed";
        stoppedBecause = `three digs in a row picked nothing up (${why})`;
        break;
      }
    }
    return { item: wanted, wanted: count, sources, collected: this.#gainedItems(before), blocksDug, stoppedBecause };
  }

  /**
   * Crafts `count` of an item, first crafting any craftable ingredients it lacks (planks from logs,
   * sticks from planks, and so on), and a crafting table if a recipe needs one and none is near.
   */
  async craftWithIngredients(item: string, count: number, depth = 0): Promise<string[]> {
    const name = requireItemName(this.#game.mcData, item);
    if (depth > MAX_CRAFT_DEPTH) {
      throw new ActionError(`Crafting ${name} needs too many intermediate steps.`);
    }
    throwIfAborted(this.#scope.signal);
    const steps: string[] = [];
    const missing = this.#game.crafter.missingIngredients(name, count);
    if (missing === null) {
      throw new ActionError(`${name} has no crafting recipe; it must be gathered, smelted or found.`);
    }
    for (const ingredient of missing) {
      if (this.#game.crafter.missingIngredients(ingredient.name, ingredient.count) === null) {
        throw new ActionError(
          `Need ${ingredient.count} more ${ingredient.name} to craft ${name}, and ${ingredient.name} cannot be crafted. Gather it first.`,
        );
      }
      steps.push(...(await this.craftWithIngredients(ingredient.name, ingredient.count, depth + 1)));
    }
    try {
      const result = await this.#game.crafter.craft(name, count, this.#actionOptions());
      steps.push(`crafted ${result.produced} ${name}`);
    } catch (error) {
      if (
        !(error instanceof ActionError) ||
        !error.message.includes("needs a crafting table") ||
        name === "crafting_table"
      ) {
        throw error;
      }
      steps.push(...(await this.#placeCraftingTable(depth)));
      const result = await this.#game.crafter.craft(name, count, this.#actionOptions());
      steps.push(`crafted ${result.produced} ${name}`);
    }
    this.#scope.progress(steps.at(-1) ?? "");
    return steps;
  }

  /**
   * Prepares a farm plot on the ground layer `y` between two corners: tills every dirt or grass block,
   * optionally pours water in the centre, and plants `seed` on the farmland.
   */
  async farmPlot(
    corner1: { x: number; z: number },
    corner2: { x: number; z: number },
    y: number,
    seed: string,
    water: boolean,
  ): Promise<FarmReport> {
    const seedItem = requireItemName(this.#game.mcData, seed);
    const minX = Math.min(corner1.x, corner2.x);
    const maxX = Math.max(corner1.x, corner2.x);
    const minZ = Math.min(corner1.z, corner2.z);
    const maxZ = Math.max(corner1.z, corner2.z);
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 1_024) {
      throw new ActionError("A farm plot is limited to 1024 cells.");
    }
    const failed: SkillFailure[] = [];
    let waterPosition: BlockPosition | null = null;
    if (water) {
      const centre = { x: Math.floor((minX + maxX) / 2), y, z: Math.floor((minZ + maxZ) / 2) };
      try {
        const current = this.#game.scanner.blockAt(centre);
        if (current !== null && !isAir(current.name) && current.name !== "water") {
          await this.#game.breaker.dig(centre, this.#actionOptions({ collectDrops: false }));
        }
        await this.#game.interactor.useItemOn(offset(centre, "down"), "water_bucket", this.#actionOptions());
        waterPosition = centre;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        failed.push({ position: centre, block: "water", reason: errorMessage(error) });
      }
    }
    const hoe = this.#bestHoe();
    let tilled = 0;
    let planted = 0;
    for (const position of serpentine(minX, maxX, minZ, maxZ, y)) {
      throwIfAborted(this.#scope.signal);
      if (waterPosition !== null && position.x === waterPosition.x && position.z === waterPosition.z) {
        continue;
      }
      try {
        const ground = this.#game.scanner.blockAt(position);
        const above = this.#game.scanner.blockAt(offset(position, "up"));
        if (above !== null && !REPLACEABLE_BLOCKS.has(above.name)) {
          failed.push({ position, block: "farmland", reason: `blocked by ${above.name} above` });
          continue;
        }
        if (ground?.name !== "farmland") {
          const after = await this.#game.interactor.useItemOn(position, hoe, this.#actionOptions());
          if (after.name !== "farmland") {
            failed.push({ position, block: "farmland", reason: `${ground?.name ?? "unknown"} could not be tilled` });
            continue;
          }
          tilled += 1;
        }
        await this.#game.interactor.useItemOn(position, seedItem, this.#actionOptions());
        planted += 1;
        if (planted % PROGRESS_EVERY === 0) {
          this.#scope.progress(`${planted} planted`);
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        failed.push({ position, block: seedItem, reason: errorMessage(error) });
      }
    }
    return { tilled, planted, water: waterPosition, failed };
  }

  async #placeCraftingTable(depth: number): Promise<string[]> {
    const steps: string[] = [];
    if (this.#game.inventory.count("crafting_table") === 0) {
      steps.push(...(await this.craftWithIngredients("crafting_table", 1, depth + 1)));
    }
    const feet = this.#game.scanner.status().position;
    const base = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
    for (const side of ["north", "south", "east", "west"] as const) {
      const spot = offset(offset(base, side), side);
      const here = this.#game.scanner.blockAt(spot);
      const below = this.#game.scanner.blockAt(offset(spot, "down"));
      if (here !== null && REPLACEABLE_BLOCKS.has(here.name) && below !== null && !REPLACEABLE_BLOCKS.has(below.name)) {
        await this.#game.placer.place(spot, "crafting_table", this.#actionOptions());
        steps.push(`placed a crafting table at ${formatPosition(spot)}`);
        return steps;
      }
    }
    throw new ActionError("No free spot next to the bot to place a crafting table.");
  }

  /** Blocks whose drops include `item`, the block of the same name first. */
  #sourceBlocks(item: string): string[] {
    const sources = Object.entries(this.#game.mcData.blockLoot)
      .filter(([, loot]) => loot.drops.some((drop) => drop.item === item))
      .map(([block]) => block);
    if (this.#game.mcData.blocksByName[item] !== undefined && !sources.includes(item)) {
      sources.push(item);
    }
    return sources.sort((a, b) => Number(b === item) - Number(a === item));
  }

  /**
   * The best block to dig next: open on top, not under the bot, closest, with blocks below the bot's
   * ground level counted as farther so the bot works across the surface instead of digging down.
   */
  #nextSource(sources: readonly string[], maxDistance: number, tried: ReadonlySet<string>): BlockPosition | null {
    const feet = this.#game.scanner.status().position;
    const support = this.#supportBlock();
    const ground = support.y;
    const candidates = this.#game.scanner
      .findBlocks(sources, { maxDistance, count: 128 })
      .filter((position) => !tried.has(`${position.x},${position.y},${position.z}`))
      .filter((position) => position.x !== support.x || position.y !== support.y || position.z !== support.z)
      .filter((position) => this.#isOpenOnTop(position));
    const score = (position: BlockPosition): number =>
      Math.hypot(position.x - feet.x, position.y - feet.y, position.z - feet.z) + 4 * Math.max(0, ground - position.y);
    return candidates.sort((a, b) => score(a) - score(b))[0] ?? null;
  }

  /** The block under the bot's feet. */
  #supportBlock(): BlockPosition {
    const feet = this.#game.scanner.status().position;
    return { x: Math.floor(feet.x), y: Math.floor(feet.y) - 1, z: Math.floor(feet.z) };
  }

  /** True when the block above is air or another replaceable block, so a drop lands in the open. */
  #isOpenOnTop(position: BlockPosition): boolean {
    const above = this.#game.scanner.blockAt(offset(position, "up"));
    return above !== null && REPLACEABLE_BLOCKS.has(above.name);
  }

  #bestHoe(): string {
    for (const hoe of ["netherite_hoe", "diamond_hoe", "iron_hoe", "golden_hoe", "stone_hoe", "wooden_hoe"]) {
      if (this.#game.inventory.count(hoe) > 0) {
        return hoe;
      }
    }
    return "wooden_hoe";
  }

  #counts(): Map<string, number> {
    return new Map(this.#game.inventory.totals().map((item) => [item.name, item.count]));
  }

  #gainedItems(before: Map<string, number>): ItemCount[] {
    const gained: ItemCount[] = [];
    for (const item of this.#game.inventory.totals()) {
      const delta = item.count - (before.get(item.name) ?? 0);
      if (delta > 0) {
        gained.push({ name: item.name, count: delta });
      }
    }
    return gained;
  }

  #gained(before: Map<string, number>): number {
    return this.#gainedItems(before).reduce((sum, item) => sum + item.count, 0);
  }

  #actionOptions<T extends object>(extra?: T): T & { signal?: AbortSignal } {
    const signal = this.#scope.signal;
    return { ...(extra ?? ({} as T)), ...(signal === undefined ? {} : { signal }) };
  }
}

/** Keeps the last plan entry for each position. */
function dedupe(blocks: readonly PlannedBlock[]): PlannedBlock[] {
  const byPosition = new Map<string, PlannedBlock>();
  for (const block of blocks) {
    byPosition.set(`${block.x},${block.y},${block.z}`, block);
  }
  return [...byPosition.values()];
}

/** Lowest layer first; within a layer, rows of z with x running back and forth. */
export function orderForBuilding<T extends { x: number; y: number; z: number }>(blocks: readonly T[]): T[] {
  return [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || (isEven(a.z) ? a.x - b.x : b.x - a.x));
}

function* serpentine(minX: number, maxX: number, minZ: number, maxZ: number, y: number): Generator<BlockPosition> {
  for (let z = minZ; z <= maxZ; z += 1) {
    const forward = (z - minZ) % 2 === 0;
    for (let i = 0; i <= maxX - minX; i += 1) {
      yield { x: forward ? minX + i : maxX - i, y, z };
    }
  }
}

function isEven(value: number): boolean {
  return Math.abs(value) % 2 === 0;
}
