import type { IndexedData } from "minecraft-data";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

import { ActionError } from "../utils/errors.ts";
import type { FindBlocksOptions, WorldScanner } from "./game-services.ts";
import { directionFromYaw, toBlockPosition, toPosition, toVec3 } from "./geometry.ts";
import { blockStateOf, requireBlockName } from "./names.ts";
import {
  boxVolume,
  formatPosition,
  isAir,
  type BlockPosition,
  type BlockState,
  type BotStatus,
  type Box,
  type EntityInfo,
  type PlayerInfo,
  type RegionSnapshot,
  type SnapshotRow,
} from "./types.ts";

const MAX_FIND_DISTANCE = 128;
const DEFAULT_SNAPSHOT_CELLS = 65_536;
const PLAYER_REACH = 6;

/** {@link WorldScanner} reading a Mineflayer bot's view of the world. */
export class MineflayerScanner implements WorldScanner {
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

  /** The bot's own condition. */
  status(): BotStatus {
    const bot = this.#bot;
    const occupied = bot.inventory.items().filter((item) => item.slot >= 9 && item.slot <= 44).length;
    return {
      username: bot.username,
      position: toPosition(bot.entity.position),
      facing: directionFromYaw(bot.entity.yaw),
      health: Math.round(bot.health * 10) / 10,
      food: bot.food,
      gameMode: bot.game.gameMode,
      dimension: bot.game.dimension.replace(/^minecraft:/, ""),
      timeOfDay: bot.time.timeOfDay,
      isRaining: bot.isRaining,
      heldItem: bot.heldItem?.name ?? null,
      onGround: bot.entity.onGround,
      freeSlots: 36 - occupied,
    };
  }

  /** The block at `position`, or null when its chunk is not loaded. */
  blockAt(position: BlockPosition): BlockState | null {
    const block = this.#bot.blockAt(toVec3(position), false);
    return block === null ? null : blockStateOf(block);
  }

  /** Positions of blocks with any of `names`, nearest first. */
  findBlocks(names: readonly string[], options: FindBlocksOptions = {}): BlockPosition[] {
    const ids = names.map((name) => {
      const blockName = requireBlockName(this.#mcData, name);
      const id = this.#mcData.blocksByName[blockName]?.id;
      if (id === undefined) {
        throw new ActionError(`Unknown block "${name}".`);
      }
      return id;
    });
    const found = this.#bot.findBlocks({
      matching: ids,
      maxDistance: Math.min(options.maxDistance ?? 32, MAX_FIND_DISTANCE),
      count: options.count ?? 20,
    });
    return found.map((point) => ({ x: point.x, y: point.y, z: point.z }));
  }

  /** Entities within `maxDistance`, nearest first. */
  entities(maxDistance = 32): EntityInfo[] {
    const self = this.#bot.entity.position;
    return Object.values(this.#bot.entities)
      .filter((entity) => entity !== this.#bot.entity && entity.position.distanceTo(self) <= maxDistance)
      .map((entity) => this.#describeEntity(entity))
      .sort((a, b) => a.distance - b.distance);
  }

  /** All online players other than the bot. */
  players(): PlayerInfo[] {
    return Object.keys(this.#bot.players)
      .filter((username) => username !== this.#bot.username)
      .map((username) => this.player(username))
      .filter((info): info is PlayerInfo => info !== null);
  }

  /** One player, or null when not online. */
  player(username: string): PlayerInfo | null {
    const player = this.#bot.players[username];
    if (player === undefined) {
      return null;
    }
    const entity = player.entity as Entity | undefined;
    if (entity === undefined) {
      return { username, position: null, facing: null, lookingAt: null, gameMode: gameModeName(player.gamemode) };
    }
    const target = this.#bot.blockAtEntityCursor(entity, PLAYER_REACH);
    const lookingAt =
      target === null || isAir(target.name)
        ? null
        : { ...blockStateOf(target), position: { x: target.position.x, y: target.position.y, z: target.position.z } };
    return {
      username,
      position: toPosition(entity.position),
      facing: directionFromYaw(entity.yaw),
      lookingAt,
      gameMode: gameModeName(player.gamemode),
    };
  }

  /** The non-air blocks in `box`. */
  snapshot(box: Box, maxCells = DEFAULT_SNAPSHOT_CELLS): RegionSnapshot {
    const cells = boxVolume(box);
    if (cells > maxCells) {
      throw new ActionError(`The box holds ${cells} cells, more than the limit of ${maxCells}. Use a smaller box.`);
    }
    const blocks: SnapshotRow[] = [];
    let unloadedCells = 0;
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      for (let z = box.min.z; z <= box.max.z; z += 1) {
        for (let x = box.min.x; x <= box.max.x; x += 1) {
          const state = this.blockAt({ x, y, z });
          if (state === null) {
            unloadedCells += 1;
          } else if (!isAir(state.name)) {
            blocks.push([x, y, z, state.name, state.properties]);
          }
        }
      }
    }
    return {
      schema: "mclab.snapshot.v1",
      box,
      takenAtMs: Date.now(),
      gameTick: this.#bot.time.age,
      unloadedCells,
      blocks,
    };
  }

  #describeEntity(entity: Entity): EntityInfo {
    const name =
      entity.type === "player"
        ? (entity.username ?? "player")
        : entity.name === "item"
          ? itemEntityName(entity)
          : (entity.displayName ?? entity.name ?? "unknown");
    return {
      id: entity.id,
      type: entity.name ?? entity.type,
      name,
      position: toPosition(entity.position),
      distance: Math.round(entity.position.distanceTo(this.#bot.entity.position) * 10) / 10,
    };
  }
}

function itemEntityName(entity: Entity): string {
  const item = entity.getDroppedItem();
  return item === null ? "item" : `${item.count} ${item.name}`;
}

function gameModeName(mode: number | undefined): string | null {
  const names = ["survival", "creative", "adventure", "spectator"];
  return mode === undefined ? null : (names[mode] ?? null);
}

/** Describes a block position for messages, for example `oak_planks at (1, 64, -3)`. */
export function describeBlockAt(state: BlockState | null, position: BlockPosition): string {
  return state === null
    ? `unloaded chunk at ${formatPosition(position)}`
    : `${state.name} at ${formatPosition(position)}`;
}

/** The block position the bot stands on. */
export function feetBlock(bot: Bot): BlockPosition {
  return toBlockPosition(bot.entity.position);
}
