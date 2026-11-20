/** Tools that run multi-step skills from the skill library. */

import { z } from "zod";

import { formatPosition } from "../../minecraft/types.ts";
import { SkillLibrary, type BuildReport, type SkillFailure } from "../../skills/skill-library.ts";
import { ToolName } from "../../utils/names.ts";
import { boxOf, boxShape, directionSchema, formatItems, orDefault } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const LONG_TIMEOUT_MS = 30 * 60_000;

function skillsFor(context: ToolContext): SkillLibrary {
  return new SkillLibrary(context.game, {
    signal: context.signal,
    progress: (message) => {
      context.progress(message);
    },
  });
}

function describeFailures(failed: readonly SkillFailure[], limit = 15): string {
  if (failed.length === 0) {
    return "";
  }
  const lines = failed
    .slice(0, limit)
    .map((failure) => `  ${failure.block} at ${formatPosition(failure.position)}: ${failure.reason}`);
  const more = failed.length > limit ? `\n  ...and ${failed.length - limit} more` : "";
  return `\nFailed (${failed.length}):\n${lines.join("\n")}${more}`;
}

function describeBuild(report: BuildReport): string {
  const replaced = report.replaced > 0 ? `, dug out ${report.replaced} blocks in the way` : "";
  return `Placed ${report.placed} of ${report.requested} blocks (${report.alreadyCorrect} were already correct${replaced}) in ${(report.durationMs / 1000).toFixed(1)} s.${describeFailures(report.failed)}`;
}

const BuildStructureArgs = z.strictObject({
  blocks: z
    .array(
      z.strictObject({
        x: z.int(),
        y: z.int(),
        z: z.int(),
        block: z.string().describe("Block item, for example oak_planks."),
        facing: directionSchema.nullable().describe("Facing for stairs, doors, chests; null for default."),
        half: z.enum(["top", "bottom"]).nullable().describe("Half for stairs and slabs; null for default."),
      }),
    )
    .min(1)
    .max(4096)
    .describe("Every block to place, in absolute coordinates. Order does not matter: the skill builds bottom-up."),
  replace: z.boolean().nullable().describe("Dig out other blocks in the way; null for false (report them instead)."),
});

/** Places a list of blocks. */
export class BuildStructureTool extends Tool<typeof BuildStructureArgs> {
  readonly name = ToolName.BUILD_STRUCTURE;
  readonly description =
    "Build a structure from a list of blocks (up to 4096). Builds the lowest layer first, walks as needed, skips blocks that are already correct, and reports every block it could not place. Use inspect_region afterwards to check.";
  readonly parameters = BuildStructureArgs;
  override readonly timeoutMs = LONG_TIMEOUT_MS;

  /** Builds. */
  async execute(args: z.infer<typeof BuildStructureArgs>, context: ToolContext): Promise<ToolResult> {
    const report = await skillsFor(context).buildStructure(args.blocks, args.replace ?? false);
    return { output: describeBuild(report), isError: report.placed + report.alreadyCorrect === 0, data: { ...report } };
  }
}

const FillRegionArgs = z.strictObject({
  ...boxShape,
  block: z.string().describe("Block item to fill with."),
  hollow: z.boolean().nullable().describe("Only the outer shell (walls, floor, roof); null for solid."),
  replace: z.boolean().nullable().describe("Dig out other blocks in the way; null for false."),
});

/** Fills a box with one block. */
export class FillRegionTool extends Tool<typeof FillRegionArgs> {
  readonly name = ToolName.FILL_REGION;
  readonly description =
    "Fill a box with one block, solid or hollow, by placing blocks like a player (up to 4096 blocks).";
  readonly parameters = FillRegionArgs;
  override readonly timeoutMs = LONG_TIMEOUT_MS;

  /** Fills. */
  async execute(args: z.infer<typeof FillRegionArgs>, context: ToolContext): Promise<ToolResult> {
    const report = await skillsFor(context).fillRegion(
      boxOf(args),
      args.block,
      args.hollow ?? false,
      args.replace ?? false,
    );
    return { output: describeBuild(report), isError: report.placed + report.alreadyCorrect === 0, data: { ...report } };
  }
}

const ClearRegionArgs = z.strictObject({ ...boxShape });

/** Breaks every block in a box. */
export class ClearRegionTool extends Tool<typeof ClearRegionArgs> {
  readonly name = ToolName.CLEAR_REGION;
  readonly description = "Break every block in a box, top layer first (up to 16384 cells). Fluids are left alone.";
  readonly parameters = ClearRegionArgs;
  override readonly timeoutMs = LONG_TIMEOUT_MS;

  /** Clears. */
  async execute(args: z.infer<typeof ClearRegionArgs>, context: ToolContext): Promise<ToolResult> {
    const report = await skillsFor(context).clearRegion(boxOf(args));
    return { output: `Removed ${report.removed} blocks.${describeFailures(report.failed)}`, data: { ...report } };
  }
}

const CollectBlocksArgs = z.strictObject({
  item: z.string().describe("Item to gather, for example dirt, cobblestone or oak_log."),
  count: z.int().min(1).max(256).describe("How many items to gain."),
  max_distance: z.int().min(4).max(128).nullable().describe("Search radius; null for 48."),
});

/** Gathers blocks of one type. */
export class CollectBlocksTool extends Tool<typeof CollectBlocksArgs> {
  readonly name = ToolName.COLLECT_BLOCKS;
  readonly description =
    "Gather an item by digging the blocks that drop it (dirt from dirt or grass blocks, cobblestone from stone): finds the nearest such block with an open top, walks there, digs it with the best tool and picks up the drop, until you gained the count. It works across the surface rather than digging down, and stops if digs stop yielding items.";
  readonly parameters = CollectBlocksArgs;
  override readonly timeoutMs = LONG_TIMEOUT_MS;

  /** Gathers. */
  async execute(args: z.infer<typeof CollectBlocksArgs>, context: ToolContext): Promise<ToolResult> {
    const report = await skillsFor(context).collectBlocks(args.item, args.count, orDefault(args.max_distance, 48));
    return {
      output: `Dug ${report.blocksDug} blocks (looking for ${report.sources.join(", ")}) and gained ${formatItems(report.collected)}; stopped because ${report.stoppedBecause}.`,
      data: { ...report },
    };
  }
}

const CraftWithIngredientsArgs = z.strictObject({
  item: z.string().describe("Item to craft, for example wooden_pickaxe."),
  count: z.int().min(1).max(256).describe("How many."),
});

/** Crafts an item and its intermediate ingredients. */
export class CraftWithIngredientsTool extends Tool<typeof CraftWithIngredientsArgs> {
  readonly name = ToolName.CRAFT_WITH_INGREDIENTS;
  readonly description =
    "Craft an item including its intermediate steps: e.g. for a wooden_pickaxe it crafts planks from logs, sticks from planks, and a crafting table if none is near. Fails naming the raw materials still missing.";
  readonly parameters = CraftWithIngredientsArgs;
  override readonly timeoutMs = 5 * 60_000;

  /** Crafts. */
  async execute(args: z.infer<typeof CraftWithIngredientsArgs>, context: ToolContext): Promise<ToolResult> {
    const steps = await skillsFor(context).craftWithIngredients(args.item, args.count);
    return {
      output: `${steps.join("; ")}. Inventory: ${formatItems(context.game.inventory.totals())}.`,
      data: { steps },
    };
  }
}

const FarmPlotArgs = z.strictObject({
  x1: z.int(),
  z1: z.int(),
  x2: z.int(),
  z2: z.int(),
  y: z.int().describe("The y of the ground blocks to till (the grass or dirt itself, not the air above)."),
  seed: z.string().describe("What to plant: wheat_seeds, carrot, potato, beetroot_seeds."),
  water: z
    .boolean()
    .describe("Dig the centre block and pour water there (one water block hydrates 4 blocks around it)."),
});

/** Tills, waters and plants a rectangular plot. */
export class FarmPlotTool extends Tool<typeof FarmPlotArgs> {
  readonly name = ToolName.FARM_PLOT;
  readonly description =
    "Turn a rectangle of grass or dirt into a planted farm: optionally put water in the centre, till every block with a hoe and plant seeds. Reports what it could not till or plant.";
  readonly parameters = FarmPlotArgs;
  override readonly timeoutMs = LONG_TIMEOUT_MS;

  /** Farms. */
  async execute(args: z.infer<typeof FarmPlotArgs>, context: ToolContext): Promise<ToolResult> {
    const report = await skillsFor(context).farmPlot(
      { x: args.x1, z: args.z1 },
      { x: args.x2, z: args.z2 },
      args.y,
      args.seed,
      args.water,
    );
    const water = report.water === null ? "no water" : `water at ${formatPosition(report.water)}`;
    return {
      output: `Tilled ${report.tilled}, planted ${report.planted}, ${water}.${describeFailures(report.failed)}`,
      data: { ...report },
    };
  }
}

TOOL_REGISTRY.register(ToolName.BUILD_STRUCTURE, BuildStructureTool);
TOOL_REGISTRY.register(ToolName.FILL_REGION, FillRegionTool);
TOOL_REGISTRY.register(ToolName.CLEAR_REGION, ClearRegionTool);
TOOL_REGISTRY.register(ToolName.COLLECT_BLOCKS, CollectBlocksTool);
TOOL_REGISTRY.register(ToolName.CRAFT_WITH_INGREDIENTS, CraftWithIngredientsTool);
TOOL_REGISTRY.register(ToolName.FARM_PLOT, FarmPlotTool);
