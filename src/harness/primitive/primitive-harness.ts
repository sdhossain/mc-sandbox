import { HarnessName, ToolName } from "../../utils/names.ts";
import { Harness, HarnessConfigSchema, type HarnessConfig } from "../harness.ts";
import { HARNESS_REGISTRY } from "../registry.ts";

/** Config of the primitive harness. It has no fields beyond the shared ones. */
export const PrimitiveHarnessConfigSchema = HarnessConfigSchema;

/** The tools of the primitive level: perception plus one atomic game action per call. */
export const PRIMITIVE_TOOLS: readonly ToolName[] = [
  ToolName.OBSERVE,
  ToolName.INSPECT_REGION,
  ToolName.FIND_BLOCKS,
  ToolName.LIST_ENTITIES,
  ToolName.BLOCK_INFO,
  ToolName.GO_TO,
  ToolName.GO_TO_PLAYER,
  ToolName.LOOK_AT,
  ToolName.PLACE_BLOCK,
  ToolName.DIG_BLOCK,
  ToolName.EQUIP,
  ToolName.TOSS,
  ToolName.CRAFT,
  ToolName.ACTIVATE_BLOCK,
  ToolName.USE_ITEM_ON,
  ToolName.CONTAINER_TRANSFER,
  ToolName.CONSUME,
  ToolName.ATTACK,
  ToolName.CHAT,
  ToolName.WAIT,
];

/**
 * Level 1, the least leverage: every tool call is one game action, such as walking somewhere,
 * placing or breaking one block, or crafting one recipe. Building a house means hundreds of calls, so
 * this level shows how well a model plans and persists step by step.
 */
export class PrimitiveHarness extends Harness {
  readonly name = HarnessName.PRIMITIVE;

  protected defaultToolNames(): readonly ToolName[] {
    return PRIMITIVE_TOOLS;
  }

  protected describeActionSpace(): string {
    return `Action space (primitive): each tool call performs one game action — walk somewhere, place or break one block, craft one recipe, use one item.
- To build, call place_block once per block, lowest layer first. You may request several tool calls in one response; they run in order, and if one fails the remaining calls of that response are skipped so you can re-plan.
- Use inspect_region to see a structure layer by layer, before building (to check the site) and after (to verify the result).
- Use observe to see your inventory and where the owner is.`;
  }
}

HARNESS_REGISTRY.register(HarnessName.PRIMITIVE, {
  configSchema: PrimitiveHarnessConfigSchema,
  create: (config: HarnessConfig, context) => new PrimitiveHarness(config, context),
});
