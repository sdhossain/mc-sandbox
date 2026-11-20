/** Tools that craft or smelt one recipe. */

import { z } from "zod";

import { formatPosition } from "../../minecraft/types.ts";
import { ToolName } from "../../utils/names.ts";
import { formatItems } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const CraftArgs = z.strictObject({
  item: z.string().describe("Item to craft, for example oak_planks, stick, crafting_table."),
  count: z.int().min(1).max(576).describe("How many items you want (rounded up to whole recipe outputs)."),
});

/** Crafts one recipe, with no intermediate steps. */
export class CraftTool extends Tool<typeof CraftArgs> {
  readonly name = ToolName.CRAFT;
  readonly description =
    "Craft an item from ingredients you carry, using one recipe (no intermediate crafting). 3x3 recipes need a crafting table within 32 blocks. On failure, reports the missing ingredients.";
  readonly parameters = CraftArgs;
  override readonly timeoutMs = 60_000;

  /** Crafts. */
  async execute(args: z.infer<typeof CraftArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.crafter.craft(args.item, args.count, { signal: context.signal });
    const station = result.station === null ? "" : ` at the crafting table at ${formatPosition(result.station)}`;
    return {
      output: `Crafted ${result.produced} ${result.item}${station}, using ${formatItems(result.consumed)}.`,
      data: { ...result },
    };
  }
}

const SmeltArgs = z.strictObject({
  item: z.string().describe("Item to smelt, for example raw_iron or sand."),
  fuel: z.string().describe("Fuel to use, for example coal, charcoal or oak_planks."),
  count: z.int().min(1).max(64).describe("How many items to smelt."),
});

/** Smelts items in a nearby furnace. */
export class SmeltTool extends Tool<typeof SmeltArgs> {
  readonly name = ToolName.SMELT;
  readonly description =
    "Smelt items in a furnace within 32 blocks: walks there, adds fuel and input, waits (about 10 s per item) and collects the output.";
  readonly parameters = SmeltArgs;
  override readonly timeoutMs = 720_000;

  /** Smelts. */
  async execute(args: z.infer<typeof SmeltArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.crafter.smelt(args.item, args.fuel, args.count, { signal: context.signal });
    return {
      output: `Smelted ${args.item}: gained ${result.produced} items, used ${formatItems(result.consumed)}. Inventory: ${formatItems(context.game.inventory.totals())}.`,
      data: { ...result },
    };
  }
}

TOOL_REGISTRY.register(ToolName.CRAFT, CraftTool);
TOOL_REGISTRY.register(ToolName.SMELT, SmeltTool);
