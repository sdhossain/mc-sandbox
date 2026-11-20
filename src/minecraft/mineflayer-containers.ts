import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";

import { runWithLimits } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError } from "../utils/errors.ts";
import type { ActionOptions, ContainerHandler, InventoryManager, Navigator } from "./game-services.ts";
import { toVec3 } from "./geometry.ts";
import { requireItemName } from "./names.ts";
import { formatPosition, type BlockPosition, type ItemCount } from "./types.ts";

const OPEN_TIMEOUT_MS = 10_000;

/** {@link ContainerHandler} for chests, barrels, shulker boxes and similar blocks. */
export class MineflayerContainers implements ContainerHandler {
  readonly #bot: Bot;
  readonly #mcData: IndexedData;
  readonly #navigator: Navigator;
  readonly #inventory: InventoryManager;

  /**
   * @param bot - A spawned bot.
   * @param mcData - Data for the server's version.
   * @param navigator - Used to walk to the container.
   * @param inventory - Used to measure what moved.
   */
  constructor(bot: Bot, mcData: IndexedData, navigator: Navigator, inventory: InventoryManager) {
    this.#bot = bot;
    this.#mcData = mcData;
    this.#navigator = navigator;
    this.#inventory = inventory;
  }

  /** What the container at `position` holds. */
  async contents(position: BlockPosition, options: ActionOptions = {}): Promise<ItemCount[]> {
    return this.#withContainer(position, options, (window) => {
      const counts = new Map<string, number>();
      for (const item of window.containerItems()) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      }
      return Promise.resolve([...counts.entries()].map(([name, count]) => ({ name, count })));
    });
  }

  /** Puts `count` of an item (all carried when omitted) into the container. */
  async deposit(
    position: BlockPosition,
    itemName: string,
    count?: number,
    options: ActionOptions = {},
  ): Promise<number> {
    const name = requireItemName(this.#mcData, itemName);
    const carried = this.#inventory.count(name);
    if (carried === 0) {
      throw new ActionError(`No ${name} in the inventory to put away.`);
    }
    const amount = Math.min(count ?? carried, carried);
    await this.#withContainer(position, options, (window) => window.deposit(this.#itemId(name), null, amount));
    return carried - this.#inventory.count(name);
  }

  /** Takes `count` of an item (all of it when omitted) out of the container. */
  async withdraw(
    position: BlockPosition,
    itemName: string,
    count?: number,
    options: ActionOptions = {},
  ): Promise<number> {
    const name = requireItemName(this.#mcData, itemName);
    const before = this.#inventory.count(name);
    await this.#withContainer(position, options, async (window) => {
      const available = window
        .containerItems()
        .filter((item) => item.name === name)
        .reduce((sum, item) => sum + item.count, 0);
      if (available === 0) {
        throw new ActionError(`The container at ${formatPosition(position)} holds no ${name}.`);
      }
      await window.withdraw(this.#itemId(name), null, Math.min(count ?? available, available));
    });
    return this.#inventory.count(name) - before;
  }

  async #withContainer<T>(
    position: BlockPosition,
    options: ActionOptions,
    use: (window: Awaited<ReturnType<Bot["openContainer"]>>) => Promise<T>,
  ): Promise<T> {
    const block = this.#bot.blockAt(toVec3(position), false);
    if (block === null) {
      throw new ActionError(`The chunk at ${formatPosition(position)} is not loaded; move closer first.`);
    }
    await this.#navigator.goTo(position, {
      range: 3,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let window: Awaited<ReturnType<Bot["openContainer"]>>;
    try {
      window = await runWithLimits(() => this.#bot.openContainer(block), {
        signal: options.signal,
        timeoutMs: OPEN_TIMEOUT_MS,
        label: `opening ${block.name}`,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ActionError(`Could not open ${block.name} at ${formatPosition(position)}: ${errorMessage(error)}.`, {
        cause: error,
      });
    }
    try {
      return await use(window);
    } finally {
      void window.close();
    }
  }

  #itemId(name: string): number {
    const id = this.#mcData.itemsByName[name]?.id;
    if (id === undefined) {
      throw new ActionError(`Unknown item "${name}".`);
    }
    return id;
  }
}
