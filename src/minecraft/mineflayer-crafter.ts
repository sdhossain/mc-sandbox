import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";

import { runWithLimits, sleep, throwIfAborted } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";
import type { ActionOptions, Crafter, CraftResult, InventoryManager, Navigator } from "./game-services.ts";
import { requireItemName } from "./names.ts";
import { formatPosition, type BlockPosition, type ItemCount } from "./types.ts";

const STATION_SEARCH_RADIUS = 32;
const CRAFT_TIMEOUT_MS = 20_000;
const SMELT_SECONDS_PER_ITEM = 10;
/** Items one unit of fuel smelts. Unlisted fuels are assumed to smelt one item. */
const FUEL_VALUE: Readonly<Record<string, number>> = {
  coal: 8,
  charcoal: 8,
  coal_block: 80,
  lava_bucket: 100,
  blaze_rod: 12,
  dried_kelp_block: 20,
  stick: 0.5,
};

/** {@link Crafter} for a Mineflayer bot. */
export class MineflayerCrafter implements Crafter {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;
  readonly #navigator: Navigator;
  readonly #inventory: InventoryManager;

  /**
   * @param bot - A spawned bot.
   * @param mcData - Data for the server's version.
   * @param navigator - Used to walk to the crafting table or furnace.
   * @param inventory - Used to measure what was produced and consumed.
   */
  constructor(bot: Bot, mcData: IndexedData, navigator: Navigator, inventory: InventoryManager) {
    this.#bot = bot;
    this.#mcData = mcData;
    this.#navigator = navigator;
    this.#inventory = inventory;
  }

  /** Crafts `count` of `itemName` with one recipe, using a nearby crafting table when needed. */
  async craft(itemName: string, count: number, options: ActionOptions = {}): Promise<CraftResult> {
    const name = requireItemName(this.#mcData, itemName);
    const itemId = this.#itemId(name);
    const table = this.#findStation("crafting_table");
    const craftable = this.#bot.recipesFor(itemId, null, 1, table);
    const recipe = craftable[0];
    if (recipe === undefined) {
      throw new ActionError(this.#explainUncraftable(name, count, table));
    }
    const times = Math.ceil(count / recipe.result.count);
    if (recipe.requiresTable && table !== null) {
      await this.#walkTo(table.position, options.signal);
    }
    const before = this.#inventory.totals();
    try {
      await runWithLimits(
        () => this.#bot.craft(recipe, times, recipe.requiresTable ? (table ?? undefined) : undefined),
        {
          signal: options.signal,
          timeoutMs: CRAFT_TIMEOUT_MS,
          label: `crafting ${name}`,
        },
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ActionError(`Crafting ${name} failed: ${errorMessage(error)}.`, { cause: error });
    }
    return this.#result(name, before, recipe.requiresTable && table !== null ? table.position : null);
  }

  /** Ingredients missing for `count` of `itemName` with the recipe that needs least; null when there is no recipe. */
  missingIngredients(itemName: string, count: number): ItemCount[] | null {
    const name = requireItemName(this.#mcData, itemName);
    const recipes = this.#bot.recipesAll(this.#itemId(name), null, true);
    if (recipes.length === 0) {
      return null;
    }
    const options = recipes.map((recipe) => this.#missingFor(recipe, count));
    return options.sort((a, b) => total(a) - total(b))[0] ?? [];
  }

  /** Smelts `count` of `itemName` in a nearby furnace and collects the output. */
  async smelt(itemName: string, fuelName: string, count: number, options: ActionOptions = {}): Promise<CraftResult> {
    const input = requireItemName(this.#mcData, itemName);
    const fuel = requireItemName(this.#mcData, fuelName);
    const furnaceBlock = this.#findStation("furnace");
    if (furnaceBlock === null) {
      throw new ActionError(
        `No furnace within ${STATION_SEARCH_RADIUS} blocks. Craft one (8 cobblestone) and place it first.`,
      );
    }
    if (this.#inventory.count(input) < count) {
      throw new ActionError(`Need ${count} ${input} to smelt but have ${this.#inventory.count(input)}.`);
    }
    const fuelNeeded = Math.ceil(count / (FUEL_VALUE[fuel] ?? 1));
    if (this.#inventory.count(fuel) < fuelNeeded) {
      throw new ActionError(`Need ${fuelNeeded} ${fuel} as fuel but have ${this.#inventory.count(fuel)}.`);
    }
    await this.#walkTo(furnaceBlock.position, options.signal);
    const before = this.#inventory.totals();
    const furnace = await runWithLimits(() => this.#bot.openFurnace(furnaceBlock), {
      signal: options.signal,
      timeoutMs: 10_000,
      label: "opening the furnace",
    });
    try {
      await furnace.putFuel(this.#itemId(fuel), null, fuelNeeded);
      await furnace.putInput(this.#itemId(input), null, count);
      const deadline = Date.now() + (count * SMELT_SECONDS_PER_ITEM + 10) * 1000;
      let collected = 0;
      while (collected < count && Date.now() < deadline) {
        throwIfAborted(options.signal);
        await sleep(1_000, options.signal);
        // Typed as always present, but null while the output slot is empty.
        const output = furnace.outputItem() as ReturnType<typeof furnace.outputItem> | null;
        if (output !== null && output.count > 0) {
          collected += output.count;
          await furnace.takeOutput();
        }
      }
    } finally {
      void furnace.close();
    }
    return this.#result(input, before, furnaceBlock.position);
  }

  #itemId(name: string): number {
    const item = this.#mcData.itemsByName[name];
    if (item === undefined) {
      throw new ActionError(`Unknown item "${name}".`);
    }
    return item.id;
  }

  #findStation(blockName: string): Block | null {
    const id = this.#mcData.blocksByName[blockName]?.id;
    if (id === undefined) {
      return null;
    }
    return this.#bot.findBlock({ matching: id, maxDistance: STATION_SEARCH_RADIUS });
  }

  async #walkTo(position: { x: number; y: number; z: number }, signal: AbortSignal | undefined): Promise<void> {
    await this.#navigator.goTo(
      { x: position.x, y: position.y, z: position.z },
      { range: 3, ...(signal === undefined ? {} : { signal }) },
    );
  }

  #explainUncraftable(name: string, count: number, table: Block | null): string {
    const anyRecipe = this.#bot.recipesAll(this.#itemId(name), null, true);
    if (anyRecipe.length === 0) {
      return `${name} has no crafting recipe. It must be found, mined, smelted or traded.`;
    }
    const needsTable = anyRecipe.every((recipe) => recipe.requiresTable);
    if (needsTable && table === null) {
      return `${name} needs a crafting table within ${STATION_SEARCH_RADIUS} blocks. Craft and place one first.`;
    }
    const missing = this.missingIngredients(name, count) ?? [];
    const list = missing.map((item) => `${item.count} ${item.name}`).join(", ");
    return `Cannot craft ${count} ${name}: missing ${list || "ingredients"}. Inventory: ${describe(this.#inventory.totals())}.`;
  }

  #missingFor(recipe: Recipe, count: number): ItemCount[] {
    const times = Math.ceil(count / recipe.result.count);
    const missing: ItemCount[] = [];
    for (const ingredient of recipe.delta) {
      if (ingredient.count >= 0) {
        continue;
      }
      const name = this.#mcData.items[ingredient.id]?.name ?? `item #${ingredient.id}`;
      const needed = -ingredient.count * times - this.#inventory.count(name);
      if (needed > 0) {
        missing.push({ name, count: needed });
      }
    }
    return missing;
  }

  #result(item: string, before: readonly ItemCount[], station: BlockPosition | null): CraftResult {
    const after = this.#inventory.totals();
    const beforeCounts = new Map(before.map((entry) => [entry.name, entry.count]));
    const afterCounts = new Map(after.map((entry) => [entry.name, entry.count]));
    const consumed: ItemCount[] = [];
    for (const [name, count] of beforeCounts) {
      const delta = count - (afterCounts.get(name) ?? 0);
      if (delta > 0 && name !== item) {
        consumed.push({ name, count: delta });
      }
    }
    const producedName = item;
    let produced = (afterCounts.get(producedName) ?? 0) - (beforeCounts.get(producedName) ?? 0);
    if (produced <= 0) {
      // Smelting produces a different item; report everything gained.
      produced = 0;
      for (const [name, count] of afterCounts) {
        const delta = count - (beforeCounts.get(name) ?? 0);
        if (delta > 0) {
          produced += delta;
        }
      }
    }
    return { item, produced, consumed, station };
  }
}

function total(items: readonly ItemCount[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

function describe(items: readonly ItemCount[]): string {
  return items.length === 0 ? "empty" : items.map((item) => `${item.count} ${item.name}`).join(", ");
}

/** Formats a station position for messages. */
export function describeStation(position: BlockPosition | null): string {
  return position === null ? "no station" : formatPosition(position);
}
