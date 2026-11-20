/** Tools that read the world without changing it. */

import { z } from "zod";

import { formatBlockState, formatPosition, type PlayerInfo } from "../../minecraft/types.ts";
import { ToolName } from "../../utils/names.ts";
import { boxOf, boxShape, formatItems, formatPositions, orDefault, positionOf, positionShape } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const ObserveArgs = z.strictObject({});

/** Reports the bot's status, inventory and the players around it. */
export class ObserveTool extends Tool<typeof ObserveArgs> {
  readonly name = ToolName.OBSERVE;
  readonly description =
    "Report your position, facing, health, food, game mode, held item, full inventory, the time, and every online player's position, facing and the block they are looking at.";
  readonly parameters = ObserveArgs;

  /** Builds the report. */
  execute(_args: z.infer<typeof ObserveArgs>, context: ToolContext): Promise<ToolResult> {
    const { scanner, inventory } = context.game;
    const status = scanner.status();
    const lines = [
      `You: ${status.username} at ${formatPosition(status.position)} facing ${status.facing}, health ${status.health}/20, food ${status.food}/20, ${status.gameMode} mode, in the ${status.dimension}.`,
      `Holding: ${status.heldItem ?? "nothing"}. Inventory (${status.freeSlots} free slots): ${formatItems(inventory.totals())}.`,
      `Time of day: ${status.timeOfDay} ticks (0 sunrise, 6000 noon, 12000 sunset, 18000 midnight)${status.isRaining ? ", raining" : ""}.`,
      ...scanner.players().map(describePlayer),
    ];
    return Promise.resolve({ output: lines.join("\n"), data: { status } });
  }
}

const InspectRegionArgs = z.strictObject({ ...boxShape });

/** Renders a box of blocks as layered text grids. */
export class InspectRegionTool extends Tool<typeof InspectRegionArgs> {
  readonly name = ToolName.INSPECT_REGION;
  readonly description =
    "Show every block in a box as text: one top-down grid per y layer (bottom first), rows are z (north at top), columns are x (west at left), with a legend. Directional blocks show facing/half in the legend. Limit 8192 cells per call; inspect big areas in parts.";
  readonly parameters = InspectRegionArgs;

  /** Renders the box. */
  execute(args: z.infer<typeof InspectRegionArgs>, context: ToolContext): Promise<ToolResult> {
    return Promise.resolve({ output: context.game.renderer.render(boxOf(args)) });
  }
}

const FindBlocksArgs = z.strictObject({
  names: z.array(z.string()).min(1).describe('Block names to look for, for example ["oak_log", "birch_log"].'),
  max_distance: z.int().min(1).max(128).nullable().describe("Search radius in blocks; null for 32."),
  count: z.int().min(1).max(200).nullable().describe("Maximum results; null for 20."),
});

/** Finds the nearest blocks of given types. */
export class FindBlocksTool extends Tool<typeof FindBlocksArgs> {
  readonly name = ToolName.FIND_BLOCKS;
  readonly description =
    "Find the nearest loaded blocks with any of the given names. Returns their positions, nearest first.";
  readonly parameters = FindBlocksArgs;

  /** Searches the loaded world. */
  execute(args: z.infer<typeof FindBlocksArgs>, context: ToolContext): Promise<ToolResult> {
    const found = context.game.scanner.findBlocks(args.names, {
      maxDistance: orDefault(args.max_distance, 32),
      count: orDefault(args.count, 20),
    });
    const output =
      found.length === 0
        ? `No ${args.names.join(" or ")} within ${orDefault(args.max_distance, 32)} blocks.`
        : `Found ${found.length}: ${formatPositions(found, 50)}`;
    return Promise.resolve({ output, data: { found } });
  }
}

const ListEntitiesArgs = z.strictObject({
  max_distance: z.int().min(1).max(128).nullable().describe("Radius in blocks; null for 32."),
});

/** Lists nearby entities: players, mobs, animals, dropped items. */
export class ListEntitiesTool extends Tool<typeof ListEntitiesArgs> {
  readonly name = ToolName.LIST_ENTITIES;
  readonly description =
    "List entities near you (players, mobs, animals, dropped items) with positions and distances, nearest first.";
  readonly parameters = ListEntitiesArgs;

  /** Lists entities. */
  execute(args: z.infer<typeof ListEntitiesArgs>, context: ToolContext): Promise<ToolResult> {
    const entities = context.game.scanner.entities(orDefault(args.max_distance, 32)).slice(0, 40);
    const output =
      entities.length === 0
        ? "No entities nearby."
        : entities
            .map(
              (entity) =>
                `${entity.name} (${entity.type}) at ${formatPosition(entity.position)}, ${entity.distance} away`,
            )
            .join("\n");
    return Promise.resolve({ output, data: { entities } });
  }
}

const BlockInfoArgs = z.strictObject({ ...positionShape });

/** Reports one block's full state. */
export class BlockInfoTool extends Tool<typeof BlockInfoArgs> {
  readonly name = ToolName.BLOCK_INFO;
  readonly description =
    "Show the block at a position with its full block state, for example oak_stairs[facing=east,half=bottom,...].";
  readonly parameters = BlockInfoArgs;

  /** Reads the block. */
  execute(args: z.infer<typeof BlockInfoArgs>, context: ToolContext): Promise<ToolResult> {
    const position = positionOf(args);
    const state = context.game.scanner.blockAt(position);
    const output =
      state === null
        ? `The chunk at ${formatPosition(position)} is not loaded.`
        : `${formatPosition(position)}: ${formatBlockState(state)}`;
    return Promise.resolve({ output, data: { state } });
  }
}

function describePlayer(player: PlayerInfo): string {
  if (player.position === null) {
    return `Player ${player.username}: online, out of view.`;
  }
  const looking =
    player.lookingAt === null
      ? "not looking at a block"
      : `looking at ${player.lookingAt.name} at ${formatPosition(player.lookingAt.position)}`;
  return `Player ${player.username}: at ${formatPosition(player.position)} facing ${player.facing ?? "?"}, ${looking}.`;
}

TOOL_REGISTRY.register(ToolName.OBSERVE, ObserveTool);
TOOL_REGISTRY.register(ToolName.INSPECT_REGION, InspectRegionTool);
TOOL_REGISTRY.register(ToolName.FIND_BLOCKS, FindBlocksTool);
TOOL_REGISTRY.register(ToolName.LIST_ENTITIES, ListEntitiesTool);
TOOL_REGISTRY.register(ToolName.BLOCK_INFO, BlockInfoTool);
