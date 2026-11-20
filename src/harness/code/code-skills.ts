import type { GameServices } from "../../minecraft/game-services.ts";
import {
  boxFromCorners,
  type BlockState,
  type BotStatus,
  type Direction,
  type ItemCount,
  type PlayerInfo,
} from "../../minecraft/types.ts";
import {
  SkillLibrary,
  type BuildReport,
  type ClearReport,
  type CollectReport,
  type FarmReport,
  type PlannedBlock,
} from "../../skills/skill-library.ts";

/**
 * The `skills` object model-written code receives in the code harness: the skill library and the
 * game layer as plain async functions with positional arguments, all bound to the call's abort signal.
 *
 * {@link describeCodeSkills} documents the same functions for the system prompt; keep the two in step.
 */
export function createCodeSkills(
  game: GameServices,
  signal: AbortSignal,
  progress: (message: string) => void,
): Record<string, unknown> {
  const library = new SkillLibrary(game, { signal, progress });
  const options = { signal };
  const box = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
    boxFromCorners({ x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 });
  return {
    goTo: (x: number, y: number, z: number, range = 1) => game.navigator.goTo({ x, y, z }, { ...options, range }),
    goToPlayer: (username: string, range = 2) => game.navigator.goToPlayer(username, { ...options, range }),
    placeBlock: (
      x: number,
      y: number,
      z: number,
      item: string,
      placement: { facing?: Direction; half?: "top" | "bottom" } = {},
    ) => game.placer.place({ x, y, z }, item, { ...options, ...placement }),
    digBlock: (x: number, y: number, z: number) => game.breaker.dig({ x, y, z }, options),
    blockAt: (x: number, y: number, z: number): BlockState | null => game.scanner.blockAt({ x, y, z }),
    findBlocks: (names: string | string[], search: { maxDistance?: number; count?: number } = {}) =>
      game.scanner.findBlocks(Array.isArray(names) ? names : [names], search),
    inspectRegion: (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): string =>
      game.renderer.render(box(x1, y1, z1, x2, y2, z2)),
    buildStructure: (blocks: PlannedBlock[], build: { replace?: boolean } = {}): Promise<BuildReport> =>
      library.buildStructure(blocks, build.replace ?? false),
    fillRegion: (
      x1: number,
      y1: number,
      z1: number,
      x2: number,
      y2: number,
      z2: number,
      block: string,
      fill: { hollow?: boolean; replace?: boolean } = {},
    ) => library.fillRegion(box(x1, y1, z1, x2, y2, z2), block, fill.hollow ?? false, fill.replace ?? false),
    clearRegion: (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Promise<ClearReport> =>
      library.clearRegion(box(x1, y1, z1, x2, y2, z2)),
    collectBlocks: (item: string, count: number, search: { maxDistance?: number } = {}): Promise<CollectReport> =>
      library.collectBlocks(item, count, search.maxDistance ?? 48),
    craft: (item: string, count = 1): Promise<string[]> => library.craftWithIngredients(item, count),
    smelt: (item: string, fuel: string, count: number) => game.crafter.smelt(item, fuel, count, options),
    farmPlot: (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      y: number,
      seed: string,
      farm: { water?: boolean } = {},
    ): Promise<FarmReport> => library.farmPlot({ x: x1, z: z1 }, { x: x2, z: z2 }, y, seed, farm.water ?? true),
    equip: (item: string, slot: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet" = "hand") =>
      game.inventory.equip(item, slot, options),
    useItemOn: (x: number, y: number, z: number, item: string) => game.interactor.useItemOn({ x, y, z }, item, options),
    activateBlock: (x: number, y: number, z: number) => game.interactor.activateBlock({ x, y, z }, options),
    inventory: (): ItemCount[] => game.inventory.totals(),
    status: (): BotStatus => game.scanner.status(),
    players: (): PlayerInfo[] => game.scanner.players(),
    say: (text: string) => game.chat.say(text),
  };
}

/** Prompt text documenting {@link createCodeSkills}. */
export function describeCodeSkills(): string {
  return `The skills object (methods of \`skills\`, not globals: write \`await skills.placeBlock(...)\`). All are async unless marked sync; coordinates are absolute; a failure throws an Error whose message says why. In creative mode, skills.placeBlock, skills.buildStructure and skills.equip take any missing item from the creative inventory, so you never need to obtain items first.
  skills.goTo(x, y, z, range = 1)                  walk with pathfinding; returns {position, distance, durationMs}
  skills.goToPlayer(name, range = 2)
  skills.placeBlock(x, y, z, item, {facing, half})  walks into reach, places, reads back; returns {block, alreadyPresent, warning}
  skills.digBlock(x, y, z)                         best tool, verifies; returns {broken, collected, warning}
  skills.blockAt(x, y, z)                  (sync)  {name, properties}, or null if not loaded
  skills.findBlocks(names, {maxDistance = 32, count = 20})   (sync) positions, nearest first
  skills.inspectRegion(x1, y1, z1, x2, y2, z2)     (sync)  layered text grid with legend (max 8192 cells)
  skills.buildStructure([{x, y, z, block, facing, half}], {replace = false})   bottom-up build; returns {placed, alreadyCorrect, failed: [{position, block, reason}]}
  skills.fillRegion(x1, y1, z1, x2, y2, z2, block, {hollow = false, replace = false})
  skills.clearRegion(x1, y1, z1, x2, y2, z2)       returns {removed, failed}
  skills.collectBlocks(item, count, {maxDistance = 48})   digs blocks that drop the item (dirt from grass too) and picks up; returns {collected, blocksDug, stoppedBecause}
  skills.craft(item, count = 1)                    crafts intermediate ingredients and a table if needed; returns the steps
  skills.smelt(item, fuel, count)                  uses a furnace within 32 blocks
  skills.farmPlot(x1, z1, x2, z2, groundY, seed, {water = true})   till, water the centre, plant
  skills.equip(item, slot = "hand"), skills.useItemOn(x, y, z, item), skills.activateBlock(x, y, z)
  skills.inventory() (sync) [{name, count}], skills.status() (sync), skills.players() (sync), skills.say(text)`;
}
