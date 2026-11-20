/** Tools that move the bot or turn its head. */

import { z } from "zod";

import { blockCenter } from "../../minecraft/geometry.ts";
import { formatPosition } from "../../minecraft/types.ts";
import { ToolName } from "../../utils/names.ts";
import { orDefault, positionOf, positionShape } from "../common.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const GoToArgs = z.strictObject({
  ...positionShape,
  range: z
    .number()
    .min(0)
    .max(32)
    .nullable()
    .describe("Stop within this many blocks; 0 to stand on the block; null for 1."),
});

/** Walks to a position with pathfinding. */
export class GoToTool extends Tool<typeof GoToArgs> {
  readonly name = ToolName.GO_TO;
  readonly description =
    "Walk to a position using pathfinding (walks, jumps, swims; does not dig or build bridges). Returns where you ended up.";
  readonly parameters = GoToArgs;
  override readonly timeoutMs = 90_000;

  /** Walks. */
  async execute(args: z.infer<typeof GoToArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.navigator.goTo(positionOf(args), {
      range: orDefault(args.range, 1),
      timeoutMs: this.timeoutMs - 5_000,
      signal: context.signal,
    });
    return {
      output: `Arrived at ${formatPosition(result.position)}, ${result.distance} blocks from the target, in ${(result.durationMs / 1000).toFixed(1)} s.`,
      data: { ...result },
    };
  }
}

const GoToPlayerArgs = z.strictObject({
  username: z.string().describe("The player's name."),
  range: z.number().min(1).max(16).nullable().describe("Stop within this many blocks; null for 2."),
});

/** Walks to a player. */
export class GoToPlayerTool extends Tool<typeof GoToPlayerArgs> {
  readonly name = ToolName.GO_TO_PLAYER;
  readonly description = "Walk to a player you can see.";
  readonly parameters = GoToPlayerArgs;
  override readonly timeoutMs = 90_000;

  /** Walks. */
  async execute(args: z.infer<typeof GoToPlayerArgs>, context: ToolContext): Promise<ToolResult> {
    const result = await context.game.navigator.goToPlayer(args.username, {
      range: orDefault(args.range, 2),
      timeoutMs: this.timeoutMs - 5_000,
      signal: context.signal,
    });
    return {
      output: `Arrived at ${formatPosition(result.position)}, ${result.distance} blocks from ${args.username}.`,
      data: { ...result },
    };
  }
}

const LookAtArgs = z.strictObject({ ...positionShape });

/** Turns to look at a block. */
export class LookAtTool extends Tool<typeof LookAtArgs> {
  readonly name = ToolName.LOOK_AT;
  readonly description = "Turn your head to look at the centre of a block.";
  readonly parameters = LookAtArgs;

  /** Looks. */
  async execute(args: z.infer<typeof LookAtArgs>, context: ToolContext): Promise<ToolResult> {
    await context.game.navigator.lookAt(blockCenter(positionOf(args)), { signal: context.signal });
    return { output: `Looking at ${formatPosition(positionOf(args))}.` };
  }
}

TOOL_REGISTRY.register(ToolName.GO_TO, GoToTool);
TOOL_REGISTRY.register(ToolName.GO_TO_PLAYER, GoToPlayerTool);
TOOL_REGISTRY.register(ToolName.LOOK_AT, LookAtTool);
