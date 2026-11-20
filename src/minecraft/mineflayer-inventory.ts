import { createRequire } from "node:module";

import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";
import type { Item as ItemClass } from "prismarine-item";

import { runWithLimits } from "../utils/abort.ts";
import { ActionError } from "../utils/errors.ts";
import type { ActionOptions, EquipSlot, InventoryManager } from "./game-services.ts";
import { requireItemName } from "./names.ts";
import type { InventorySlot, ItemCount } from "./types.ts";

/** First hotbar slot in the player inventory window; the hotbar is slots 36 to 44. */
const HOTBAR_START = 36;
const INVENTORY_SIZE = 36;

/** prismarine-item's loader. Its type declarations claim an ES default export, but it is a CommonJS function. */
const loadItemClass = createRequire(import.meta.url)("prismarine-item") as (version: string) => typeof ItemClass;
const EQUIP_TIMEOUT_MS = 5_000;

/** {@link InventoryManager} for a Mineflayer bot. */
export class MineflayerInventory implements InventoryManager {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;

  /**
   * @param bot - A spawned bot.
   * @param mcData - Data for the server's version.
   */
  constructor(bot: Bot, mcData: IndexedData) {
    this.#bot = bot;
    this.#mcData = mcData;
  }

  /** Every occupied slot of the 36 main slots plus armour and off-hand. */
  slots(): InventorySlot[] {
    return this.#bot.inventory.items().map((item) => ({ name: item.name, count: item.count, slot: item.slot }));
  }

  /** Items summed by name, most numerous first. */
  totals(): ItemCount[] {
    const counts = new Map<string, number>();
    for (const item of this.#bot.inventory.items()) {
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  /** How many of `itemName` the bot carries. */
  count(itemName: string): number {
    return this.#bot.inventory
      .items()
      .filter((item) => item.name === itemName)
      .reduce((sum, item) => sum + item.count, 0);
  }

  /** The item in the main hand, or null. */
  heldItem(): string | null {
    return this.#bot.heldItem?.name ?? null;
  }

  /** Empty slots among the 36 main inventory slots. */
  freeSlots(): number {
    return INVENTORY_SIZE - this.#bot.inventory.items().filter((item) => item.slot < HOTBAR_START + 9).length;
  }

  /** Equips an item; in creative mode a missing item is first taken from the creative inventory. */
  async equip(itemName: string, slot: EquipSlot = "hand", options: ActionOptions = {}): Promise<void> {
    const name = requireItemName(this.#mcData, itemName);
    if (slot === "hand" && this.#bot.heldItem?.name === name) {
      return;
    }
    let item = this.#find(name);
    if (item === undefined && this.#isCreative()) {
      await this.giveCreative(name, 1, options);
      item = this.#find(name);
    }
    if (item === undefined) {
      throw new ActionError(`No ${name} in the inventory. Inventory: ${this.#describe()}.`);
    }
    const found = item;
    await runWithLimits(() => this.#bot.equip(found, slot), {
      signal: options.signal,
      timeoutMs: EQUIP_TIMEOUT_MS,
      label: `equipping ${name}`,
    });
  }

  /** Drops `count` of an item, or all of it. Returns the number dropped. */
  async toss(itemName: string, count?: number, options: ActionOptions = {}): Promise<number> {
    const name = requireItemName(this.#mcData, itemName);
    const available = this.count(name);
    if (available === 0) {
      throw new ActionError(`No ${name} in the inventory to drop.`);
    }
    const amount = Math.min(count ?? available, available);
    const itemId = this.#mcData.itemsByName[name]?.id ?? 0;
    await runWithLimits(() => this.#bot.toss(itemId, null, amount), {
      signal: options.signal,
      timeoutMs: EQUIP_TIMEOUT_MS,
      label: `dropping ${name}`,
    });
    return amount;
  }

  /** Creative mode only: puts `count` of an item into the selected hotbar slot. */
  async giveCreative(itemName: string, count: number, options: ActionOptions = {}): Promise<void> {
    if (!this.#isCreative()) {
      throw new ActionError(
        `Cannot take ${itemName} from the creative inventory: the bot is in ${this.#bot.game.gameMode} mode.`,
      );
    }
    const name = requireItemName(this.#mcData, itemName);
    const definition = this.#mcData.itemsByName[name];
    if (definition === undefined) {
      throw new ActionError(`Unknown item "${itemName}".`);
    }
    const Item = loadItemClass(this.#bot.version);
    const stack = Math.max(1, Math.min(count, definition.stackSize));
    const slot = HOTBAR_START + this.#bot.quickBarSlot;
    await runWithLimits(() => this.#bot.creative.setInventorySlot(slot, new Item(definition.id, stack)), {
      signal: options.signal,
      timeoutMs: EQUIP_TIMEOUT_MS,
      label: `taking ${name} from the creative inventory`,
    });
  }

  #find(name: string): ReturnType<Bot["inventory"]["items"]>[number] | undefined {
    return this.#bot.inventory.items().find((item) => item.name === name);
  }

  #isCreative(): boolean {
    return this.#bot.game.gameMode === "creative";
  }

  #describe(): string {
    const totals = this.totals();
    return totals.length === 0 ? "empty" : totals.map((item) => `${item.count} ${item.name}`).join(", ");
  }
}
