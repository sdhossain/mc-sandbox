/**
 * An in-memory stand-in for the game layer, for unit tests of tools, skills and the agent loop.
 * Blocks live in a map; everything else is the minimum the code under test touches.
 */

import { EventEmitter } from "node:events";

import type { IndexedData } from "minecraft-data";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";

import type {
  BlockBreaker,
  BlockChangeRecorder,
  BlockPlacer,
  ChatChannel,
  ChatMessage,
  ContainerHandler,
  Crafter,
  GameServices,
  Interactor,
  InventoryManager,
  Navigator,
  WorldScanner,
} from "../../src/minecraft/game-services.ts";
import { placedBlockName } from "../../src/minecraft/names.ts";
import { TextRegionRenderer } from "../../src/minecraft/text-region-renderer.ts";
import {
  boxVolume,
  isAir,
  type BlockChange,
  type BlockPosition,
  type BlockState,
  type BotStatus,
  type Box,
  type RegionSnapshot,
  type SnapshotRow,
} from "../../src/minecraft/types.ts";
import { ActionError } from "../../src/utils/errors.ts";

const AIR: BlockState = { name: "air", properties: {} };

/** A flat world: grass at y = 63 and below, air above, plus whatever tests place. */
export class FakeWorld {
  readonly blocks = new Map<string, BlockState>();
  readonly changes: BlockChange[] = [];
  readonly #listeners = new Set<(change: BlockChange) => void>();

  get(position: BlockPosition): BlockState {
    return this.blocks.get(key(position)) ?? (position.y <= 63 ? { name: "grass_block", properties: {} } : AIR);
  }

  set(position: BlockPosition, state: BlockState): void {
    const before = this.get(position);
    this.blocks.set(key(position), state);
    const change: BlockChange = {
      seq: this.changes.length + 1,
      timeMs: Date.now(),
      gameTick: 0,
      position,
      before,
      after: state,
      cause: "bot",
    };
    this.changes.push(change);
    for (const listener of this.#listeners) {
      listener(change);
    }
  }

  onChange(listener: (change: BlockChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** Fake game services over a {@link FakeWorld}. `said` collects chat lines. */
export class FakeGame implements GameServices {
  readonly world = new FakeWorld();
  readonly said: string[] = [];
  readonly bot = Object.assign(new EventEmitter(), {
    username: "Sol",
    version: "1.21.11",
    stopDigging: () => undefined,
  }) as unknown as Bot;
  readonly mcData: IndexedData = minecraftData("1.21.11");
  position: BlockPosition = { x: 0, y: 64, z: 0 };
  gameMode = "creative";

  readonly navigator: Navigator = {
    goTo: (target) => {
      this.position = target;
      return Promise.resolve({ position: target, distance: 0, durationMs: 1 });
    },
    goToPlayer: () => Promise.reject(new ActionError("not in view")),
    lookAt: () => Promise.resolve(),
    face: () => Promise.resolve(),
    stop: () => undefined,
  };

  readonly placer: BlockPlacer = {
    place: (target, itemName) => {
      const name = placedBlockName(itemName);
      const current = this.world.get(target);
      if (current.name === name) {
        return Promise.resolve({
          position: target,
          block: current,
          against: null,
          alreadyPresent: true,
          warning: null,
        });
      }
      if (!isAir(current.name)) {
        return Promise.reject(new ActionError(`occupied by ${current.name}`));
      }
      const below = this.world.get({ ...target, y: target.y - 1 });
      if (isAir(below.name) && !this.#hasSideNeighbour(target)) {
        return Promise.reject(new ActionError("Nothing solid next to it"));
      }
      const block = { name, properties: {} };
      this.world.set(target, block);
      return Promise.resolve({
        position: target,
        block,
        against: { ...target, y: target.y - 1 },
        alreadyPresent: false,
        warning: null,
      });
    },
  };

  readonly breaker: BlockBreaker = {
    dig: (target) => {
      const broken = this.world.get(target);
      if (isAir(broken.name)) {
        return Promise.reject(new ActionError("There is no block to dig"));
      }
      this.world.set(target, AIR);
      return Promise.resolve({ position: target, broken, tool: null, collected: [], warning: null });
    },
  };

  readonly inventory: InventoryManager = {
    slots: () => [],
    totals: () => [],
    count: () => 0,
    heldItem: () => null,
    freeSlots: () => 36,
    equip: () => Promise.resolve(),
    toss: () => Promise.resolve(0),
    giveCreative: () => Promise.resolve(),
  };

  readonly crafter: Crafter = {
    craft: () => Promise.reject(new ActionError("no crafting in the fake world")),
    missingIngredients: () => null,
    smelt: () => Promise.reject(new ActionError("no furnace in the fake world")),
  };

  readonly containers: ContainerHandler = {
    contents: () => Promise.resolve([]),
    deposit: () => Promise.resolve(0),
    withdraw: () => Promise.resolve(0),
  };

  readonly interactor: Interactor = {
    activateBlock: (position) => Promise.resolve(this.world.get(position)),
    useItemOn: (position, item) => {
      if (item.endsWith("_hoe") && this.world.get(position).name === "grass_block") {
        this.world.set(position, { name: "farmland", properties: { moisture: "0" } });
      } else if (item === "wheat_seeds" && this.world.get(position).name === "farmland") {
        this.world.set({ ...position, y: position.y + 1 }, { name: "wheat", properties: { age: "0" } });
      } else if (item === "water_bucket") {
        this.world.set({ ...position, y: position.y + 1 }, { name: "water", properties: { level: "0" } });
      }
      return Promise.resolve(this.world.get(position));
    },
    consume: () => Promise.resolve(),
    attack: () => Promise.resolve("done"),
  };

  readonly scanner: WorldScanner = {
    status: (): BotStatus => ({
      username: "Sol",
      position: this.position,
      facing: "north",
      health: 20,
      food: 20,
      gameMode: this.gameMode,
      dimension: "overworld",
      timeOfDay: 6000,
      isRaining: false,
      heldItem: null,
      onGround: true,
      freeSlots: 36,
    }),
    blockAt: (position) => this.world.get(position),
    findBlocks: (names) => {
      const distanceTo = (position: BlockPosition): number =>
        Math.hypot(position.x - this.position.x, position.y - this.position.y, position.z - this.position.z);
      return [...this.world.blocks.entries()]
        .filter(([, state]) => names.includes(state.name))
        .map(([key]) => {
          const [x = 0, y = 0, z = 0] = key.split(",").map(Number);
          return { x, y, z };
        })
        .sort((a, b) => distanceTo(a) - distanceTo(b));
    },
    entities: () => [],
    players: () => [],
    player: () => null,
    snapshot: (box: Box): RegionSnapshot => {
      const blocks: SnapshotRow[] = [];
      for (let y = box.min.y; y <= box.max.y; y += 1) {
        for (let z = box.min.z; z <= box.max.z; z += 1) {
          for (let x = box.min.x; x <= box.max.x; x += 1) {
            const state = this.world.get({ x, y, z });
            if (!isAir(state.name)) {
              blocks.push([x, y, z, state.name, state.properties]);
            }
          }
        }
      }
      if (boxVolume(box) > 1_000_000) {
        throw new ActionError("too big");
      }
      return { schema: "mclab.snapshot.v1", box, takenAtMs: 0, gameTick: 0, unloadedCells: 0, blocks };
    },
  };

  readonly renderer = new TextRegionRenderer((position) => this.world.get(position));

  readonly chat: ChatChannel = {
    say: (text) => {
      this.said.push(text);
      return Promise.resolve();
    },
    whisper: (_username, text) => {
      this.said.push(text);
      return Promise.resolve();
    },
    onMessage: (_listener: (message: ChatMessage) => void) => () => undefined,
  };

  readonly changes: BlockChangeRecorder = {
    lastSeq: () => this.world.changes.length,
    since: (seq) => this.world.changes.filter((change) => change.seq > seq),
    onChange: (listener) => this.world.onChange(listener),
    expectChange: () => undefined,
  };

  #hasSideNeighbour(target: BlockPosition): boolean {
    const sides = [
      { ...target, x: target.x + 1 },
      { ...target, x: target.x - 1 },
      { ...target, z: target.z + 1 },
      { ...target, z: target.z - 1 },
      { ...target, y: target.y + 1 },
    ];
    return sides.some((side) => !isAir(this.world.get(side).name));
  }
}

function key(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}
