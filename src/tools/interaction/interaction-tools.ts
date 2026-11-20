/** Tools for right-click interactions, containers, eating, combat and server commands. */

import { z } from "zod";

import { offset } from "../../minecraft/geometry.ts";
import { formatBlockState, formatPosition } from "../../minecraft/types.ts";
import { ActionError } from "../../utils/errors.ts";
import { ToolName } from "../../utils/names.ts";
import { truncateMiddle } from "../../utils/text.ts";
import { formatItems, positionOf, positionShape } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const ActivateBlockArgs = z.strictObject({ ...positionShape });

/** Right-clicks a block. */
export class ActivateBlockTool extends Tool<typeof ActivateBlockArgs> {
  readonly name = ToolName.ACTIVATE_BLOCK;
  readonly description = "Right-click a block: open or close a door, gate or trapdoor, press a button, flip a lever.";
  readonly parameters = ActivateBlockArgs;

  /** Activates. */
  async execute(args: z.infer<typeof ActivateBlockArgs>, context: ToolContext): Promise<ToolResult> {
    const state = await context.game.interactor.activateBlock(positionOf(args), { signal: context.signal });
    return { output: `Used the block; it is now ${formatBlockState(state)}.` };
  }
}

const UseItemOnArgs = z.strictObject({
  ...positionShape,
  item: z.string().describe("Item to use, for example wooden_hoe, wheat_seeds, water_bucket, bone_meal."),
});

/** Uses a held item on a block. */
export class UseItemOnTool extends Tool<typeof UseItemOnArgs> {
  readonly name = ToolName.USE_ITEM_ON;
  readonly description =
    "Hold an item and right-click a block with it: a hoe tills dirt or grass into farmland, seeds plant on farmland (target the farmland), a water bucket pours water on top of the target block, bone meal grows crops. Reports the block and the block above afterwards.";
  readonly parameters = UseItemOnArgs;

  /** Uses the item. */
  async execute(args: z.infer<typeof UseItemOnArgs>, context: ToolContext): Promise<ToolResult> {
    const position = positionOf(args);
    const state = await context.game.interactor.useItemOn(position, args.item, { signal: context.signal });
    const above = context.game.scanner.blockAt(offset(position, "up"));
    return {
      output: `Used ${args.item} on ${formatPosition(position)}: it is now ${formatBlockState(state)}; above it: ${above === null ? "unknown" : formatBlockState(above)}.`,
    };
  }
}

const ContainerTransferArgs = z.strictObject({
  ...positionShape,
  action: z
    .enum(["view", "deposit", "withdraw"])
    .describe("view the contents, deposit items into it, or withdraw items from it."),
  item: z.string().nullable().describe("Item to move; null for view."),
  count: z.int().min(1).nullable().describe("How many; null for all."),
});

/** Views or moves items in a chest or other container. */
export class ContainerTransferTool extends Tool<typeof ContainerTransferArgs> {
  readonly name = ToolName.CONTAINER_TRANSFER;
  readonly description =
    "Open a chest, barrel or other container to view its contents, deposit items into it, or withdraw items.";
  readonly parameters = ContainerTransferArgs;

  /** Opens the container and acts. */
  async execute(args: z.infer<typeof ContainerTransferArgs>, context: ToolContext): Promise<ToolResult> {
    const position = positionOf(args);
    const { containers, inventory } = context.game;
    const options = { signal: context.signal };
    if (args.action === "view") {
      return {
        output: `Container at ${formatPosition(position)} holds: ${formatItems(await containers.contents(position, options))}.`,
      };
    }
    if (args.item === null) {
      throw new ActionError(`Name the item to ${args.action}.`);
    }
    const moved =
      args.action === "deposit"
        ? await containers.deposit(position, args.item, args.count ?? undefined, options)
        : await containers.withdraw(position, args.item, args.count ?? undefined, options);
    return {
      output: `${args.action === "deposit" ? "Deposited" : "Withdrew"} ${moved} ${args.item}. Inventory: ${formatItems(inventory.totals())}.`,
    };
  }
}

const ConsumeArgs = z.strictObject({ item: z.string().describe("Food or potion to consume, for example bread.") });

/** Eats or drinks. */
export class ConsumeTool extends Tool<typeof ConsumeArgs> {
  readonly name = ToolName.CONSUME;
  readonly description = "Eat food or drink a potion from your inventory.";
  readonly parameters = ConsumeArgs;

  /** Consumes. */
  async execute(args: z.infer<typeof ConsumeArgs>, context: ToolContext): Promise<ToolResult> {
    await context.game.interactor.consume(args.item, { signal: context.signal });
    const status = context.game.scanner.status();
    return { output: `Consumed ${args.item}. Health ${status.health}/20, food ${status.food}/20.` };
  }
}

const AttackArgs = z.strictObject({
  target: z.string().describe("Entity type or name, for example zombie, cow, or a player name."),
});

/** Attacks the nearest matching entity. */
export class AttackTool extends Tool<typeof AttackArgs> {
  readonly name = ToolName.ATTACK;
  readonly description =
    "Attack the nearest entity of a type or name within 16 blocks until it dies (30 s limit). Equip a weapon first.";
  readonly parameters = AttackArgs;
  override readonly timeoutMs = 45_000;

  /** Attacks. */
  async execute(args: z.infer<typeof AttackArgs>, context: ToolContext): Promise<ToolResult> {
    return { output: await context.game.interactor.attack(args.target, { signal: context.signal }) };
  }
}

const RunCommandArgs = z.strictObject({
  command: z.string().min(1).describe("A server command, for example /fill 0 64 0 9 64 9 stone or /time set day."),
});

/** Runs a server command as the bot (operator privilege). */
export class RunCommandTool extends Tool<typeof RunCommandArgs> {
  readonly name = ToolName.RUN_COMMAND;
  readonly description =
    "Run a server command as yourself, at your position (so ~ ~ ~ and @s refer to you). Returns the server's reply.";
  readonly parameters = RunCommandArgs;

  /** Runs the command through the lab's operator channel. */
  async execute(args: z.infer<typeof RunCommandArgs>, context: ToolContext): Promise<ToolResult> {
    const reply = await context.server.runAs(context.agentName, args.command);
    return { output: reply.trim().length === 0 ? "Command ran (no reply)." : truncateMiddle(reply, 2_000) };
  }
}

TOOL_REGISTRY.register(ToolName.ACTIVATE_BLOCK, ActivateBlockTool);
TOOL_REGISTRY.register(ToolName.USE_ITEM_ON, UseItemOnTool);
TOOL_REGISTRY.register(ToolName.CONTAINER_TRANSFER, ContainerTransferTool);
TOOL_REGISTRY.register(ToolName.CONSUME, ConsumeTool);
TOOL_REGISTRY.register(ToolName.ATTACK, AttackTool);
TOOL_REGISTRY.register(ToolName.RUN_COMMAND, RunCommandTool);
