import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";

import type {
  BlockBreaker,
  BlockPlacer,
  ContainerHandler,
  Crafter,
  GameServices,
  Interactor,
  InventoryManager,
  Navigator,
  RegionRenderer,
  WorldScanner,
} from "./game-services.ts";
import { MineflayerBreaker } from "./mineflayer-breaker.ts";
import { MineflayerChangeRecorder } from "./mineflayer-change-recorder.ts";
import { MineflayerChat } from "./mineflayer-chat.ts";
import { MineflayerContainers } from "./mineflayer-containers.ts";
import { MineflayerCrafter } from "./mineflayer-crafter.ts";
import { MineflayerInteractor } from "./mineflayer-interactor.ts";
import { MineflayerInventory } from "./mineflayer-inventory.ts";
import { MineflayerPlacer } from "./mineflayer-placer.ts";
import { MineflayerScanner } from "./mineflayer-scanner.ts";
import { DEFAULT_MOVEMENT_SETTINGS, PathfinderNavigator, type MovementSettings } from "./pathfinder-navigator.ts";
import { TextRegionRenderer } from "./text-region-renderer.ts";

/** The game layer for one spawned Mineflayer bot. Rebuilt on every (re)connect. */
export class MineflayerGameServices implements GameServices {
  readonly bot: Bot;
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
  readonly chat: MineflayerChat;
  readonly changes: MineflayerChangeRecorder;

  /**
   * @param bot - A spawned bot with the pathfinder plugin loaded.
   * @param mcData - Data for the server's version.
   * @param movement - How the bot may move while pathfinding.
   */
  constructor(bot: Bot, mcData: IndexedData, movement: MovementSettings = DEFAULT_MOVEMENT_SETTINGS) {
    this.bot = bot;
    this.mcData = mcData;
    this.changes = new MineflayerChangeRecorder(bot);
    this.chat = new MineflayerChat(bot);
    this.navigator = new PathfinderNavigator(bot, movement);
    this.inventory = new MineflayerInventory(bot, mcData);
    this.placer = new MineflayerPlacer(bot, mcData, this.navigator, this.inventory, this.changes);
    this.breaker = new MineflayerBreaker(bot, mcData, this.navigator, this.inventory, this.changes);
    this.crafter = new MineflayerCrafter(bot, mcData, this.navigator, this.inventory);
    this.containers = new MineflayerContainers(bot, mcData, this.navigator, this.inventory);
    this.interactor = new MineflayerInteractor(bot, mcData, this.navigator, this.inventory, this.changes);
    const scanner = new MineflayerScanner(bot, mcData);
    this.scanner = scanner;
    this.renderer = new TextRegionRenderer((position) => scanner.blockAt(position));
  }

  /** Detaches every listener from the bot. */
  dispose(): void {
    this.navigator.stop();
    this.changes.dispose();
    this.chat.dispose();
  }
}
