/** Tools that rearrange or fill the inventory. */

import { z } from "zod";

import { ToolName } from "../../utils/names.ts";
import { formatItems } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const EquipArgs = z.strictObject({
  item: z.string().describe("Item name, for example diamond_pickaxe."),
  slot: z
    .enum(["hand", "off-hand", "head", "torso", "legs", "feet"])
    .nullable()
    .describe("Where to equip it; null for hand."),
});

/** Equips an item. */
export class EquipTool extends Tool<typeof EquipArgs> {
  readonly name = ToolName.EQUIP;
  readonly description = "Hold an item in your hand, or wear armour.";
  readonly parameters = EquipArgs;

  /** Equips. */
  async execute(args: z.infer<typeof EquipArgs>, context: ToolContext): Promise<ToolResult> {
    await context.game.inventory.equip(args.item, args.slot ?? "hand", { signal: context.signal });
    return { output: `Equipped ${args.item} (${args.slot ?? "hand"}).` };
  }
}

const TossArgs = z.strictObject({
  item: z.string().describe("Item name."),
  count: z.int().min(1).nullable().describe("How many; null for all."),
});

/** Drops items on the ground. */
export class TossTool extends Tool<typeof TossArgs> {
  readonly name = ToolName.TOSS;
  readonly description =
    "Drop items on the ground in front of you, for example to give them to a player standing there.";
  readonly parameters = TossArgs;

  /** Drops. */
  async execute(args: z.infer<typeof TossArgs>, context: ToolContext): Promise<ToolResult> {
    const dropped = await context.game.inventory.toss(args.item, args.count ?? undefined, { signal: context.signal });
    return { output: `Dropped ${dropped} ${args.item}. Inventory: ${formatItems(context.game.inventory.totals())}.` };
  }
}

const GiveItemArgs = z.strictObject({
  item: z.string().describe("Item name."),
  count: z.int().min(1).max(64).describe("How many, up to one stack."),
});

/** Creative mode: takes items from the creative inventory. */
export class GiveItemTool extends Tool<typeof GiveItemArgs> {
  readonly name = ToolName.GIVE_ITEM;
  readonly description =
    "Creative mode only: take up to one stack of any item from the creative inventory into your hand. (place_block already does this for blocks you lack.)";
  readonly parameters = GiveItemArgs;

  /** Gives. */
  async execute(args: z.infer<typeof GiveItemArgs>, context: ToolContext): Promise<ToolResult> {
    await context.game.inventory.giveCreative(args.item, args.count, { signal: context.signal });
    return { output: `Took ${args.count} ${args.item}. Inventory: ${formatItems(context.game.inventory.totals())}.` };
  }
}

TOOL_REGISTRY.register(ToolName.EQUIP, EquipTool);
TOOL_REGISTRY.register(ToolName.TOSS, TossTool);
TOOL_REGISTRY.register(ToolName.GIVE_ITEM, GiveItemTool);
