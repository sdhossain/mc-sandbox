import { HarnessName, ToolName } from "../../utils/names.ts";
import { Harness, HarnessConfigSchema, type HarnessConfig } from "../harness.ts";
import { PRIMITIVE_TOOLS } from "../primitive/primitive-harness.ts";
import { HARNESS_REGISTRY } from "../registry.ts";

/** Config of the skills harness. It has no fields beyond the shared ones. */
export const SkillsHarnessConfigSchema = HarnessConfigSchema;

/** The primitive tools plus the multi-step skills. */
export const SKILLS_TOOLS: readonly ToolName[] = [
  ...PRIMITIVE_TOOLS,
  ToolName.SMELT,
  ToolName.BUILD_STRUCTURE,
  ToolName.FILL_REGION,
  ToolName.CLEAR_REGION,
  ToolName.COLLECT_BLOCKS,
  ToolName.CRAFT_WITH_INGREDIENTS,
  ToolName.FARM_PLOT,
];

/**
 * Level 2: the primitive tools plus hand-written skills that each do a whole sub-task — build from a
 * block list, fill or clear a box, gather a resource, craft with intermediate steps, prepare a farm
 * plot. The model plans; the skills execute. This level shows how well a model plans when execution
 * is reliable.
 */
export class SkillsHarness extends Harness {
  readonly name = HarnessName.SKILLS;

  protected defaultToolNames(): readonly ToolName[] {
    return SKILLS_TOOLS;
  }

  protected describeActionSpace(): string {
    return `Action space (skills): single-action tools plus skills that each carry out a whole sub-task.
- To build, plan the complete list of blocks in absolute coordinates and call build_structure (or fill_region for boxes). The skill orders the work bottom-up, walks as needed, and reports every block it could not place; fix those, then verify with inspect_region.
- Use collect_blocks to gather a resource and craft_with_ingredients to craft an item together with its intermediate ingredients. farm_plot tills, waters and plants a rectangle.
- Single-action tools (place_block, dig_block, use_item_on, ...) are still available for small fixes.`;
  }
}

HARNESS_REGISTRY.register(HarnessName.SKILLS, {
  configSchema: SkillsHarnessConfigSchema,
  create: (config: HarnessConfig, context) => new SkillsHarness(config, context),
});
