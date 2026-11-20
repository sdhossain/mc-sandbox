/** Tools that place or break single blocks. */

import { z } from "zod";

import { formatBlockState, formatPosition } from "../../minecraft/types.ts";
import { ToolName } from "../../utils/names.ts";
import { directionSchema, formatItems, positionOf, positionShape } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const PlaceBlockArgs = z.strictObject({
  ...positionShape,
  item: z.string().describe("The block item to place, for example oak_planks or wheat_seeds."),
  facing: directionSchema
    .nullable()
    .describe("Direction the placed block should face (stairs, doors, chests, furnaces); null to not care."),
  half: z
    .enum(["top", "bottom"])
    .nullable()
    .describe("Upper or lower half for stairs, slabs and trapdoors; null for default."),
});

/** Places one block, walking into reach first. */
export class PlaceBlockTool extends Tool<typeof PlaceBlockArgs> {
  readonly name = ToolName.PLACE_BLOCK;
  readonly description =
    "Place one block at a position. Walks into reach first. The position must be empty (air, water or grass) and touch an existing block to place against. Reports the block now there.";
  readonly parameters = PlaceBlockArgs;
  override readonly timeoutMs = 60_000;

  /** Places the block. */
  async execute(args: z.infer<typeof PlaceBlockArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.placer.place(positionOf(args), args.item, {
      ...(args.facing === null ? {} : { facing: args.facing }),
      ...(args.half === null ? {} : { half: args.half }),
      signal: context.signal,
    });
    const what = formatBlockState(result.block);
    const output = result.alreadyPresent
      ? `${formatPosition(result.position)} already holds ${what}; nothing placed.`
      : `Placed ${what} at ${formatPosition(result.position)}.${result.warning === null ? "" : ` Warning: ${result.warning}`}`;
    return { output, data: { ...result } };
  }
}

const DigBlockArgs = z.strictObject({ ...positionShape });

/** Breaks one block with the best tool carried. */
export class DigBlockTool extends Tool<typeof DigBlockArgs> {
  readonly name = ToolName.DIG_BLOCK;
  readonly description =
    "Break the block at a position, walking into reach and equipping the best tool you carry. In survival, picks up the drop.";
  readonly parameters = DigBlockArgs;
  override readonly timeoutMs = 60_000;

  /** Digs the block. */
  async execute(args: z.infer<typeof DigBlockArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.breaker.dig(positionOf(args), { signal: context.signal });
    const parts = [
      `Broke ${result.broken.name} at ${formatPosition(result.position)}${result.tool === null ? "" : ` with ${result.tool}`}.`,
    ];
    if (result.collected.length > 0) {
      parts.push(`Collected ${formatItems(result.collected)}.`);
    }
    if (result.warning !== null) {
      parts.push(`Warning: ${result.warning}`);
    }
    return { output: parts.join(" "), data: { ...result } };
  }
}

TOOL_REGISTRY.register(ToolName.PLACE_BLOCK, PlaceBlockTool);
TOOL_REGISTRY.register(ToolName.DIG_BLOCK, DigBlockTool);
