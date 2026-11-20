import { z } from "zod";

import { RunCodeTool } from "../../tools/code/run-code-tool.ts";
import type { Tool } from "../../tools/tool.ts";
import { HarnessName, ToolName } from "../../utils/names.ts";
import { Harness, HarnessConfigSchema, type HarnessContext } from "../harness.ts";
import { HARNESS_REGISTRY } from "../registry.ts";
import { CodeRunner } from "./code-runner.ts";
import { describeCodeSkills } from "./code-skills.ts";

/** Config of the code harness. */
export const CodeHarnessConfigSchema = HarnessConfigSchema.extend({
  harness: z.literal(HarnessName.CODE),
  /** Give the code the `skills` library. False leaves only the raw Mineflayer API (the `code-raw` preset). */
  helpers: z.boolean().default(true),
  /** Time limit of a `run_code` call when the model gives none. */
  defaultTimeoutSeconds: z.int().positive().default(60),
  /** The longest time limit a `run_code` call may ask for. */
  maxTimeoutSeconds: z.int().positive().default(900),
  toolOutputMaxChars: z.int().positive().default(20_000),
});

/** See {@link CodeHarnessConfigSchema}. */
export type CodeHarnessConfig = z.infer<typeof CodeHarnessConfigSchema>;

/** Perception tools stay available so the model can look without writing code. */
const CODE_TOOLS: readonly ToolName[] = [
  ToolName.OBSERVE,
  ToolName.INSPECT_REGION,
  ToolName.FIND_BLOCKS,
  ToolName.LIST_ENTITIES,
  ToolName.BLOCK_INFO,
  ToolName.CHAT,
  ToolName.RUN_CODE,
];

/**
 * Level 3, the most leverage: the model writes JavaScript that runs against the live Mineflayer bot,
 * with full access to its API, plus (unless `helpers` is off) the same skill library the skills
 * harness offers as tools. One call can build a whole structure in a loop, so this level shows how
 * well a model programs the game.
 */
export class CodeHarness extends Harness<CodeHarnessConfig> {
  readonly name = HarnessName.CODE;
  readonly #runner: CodeRunner;

  /**
   * @param config - Validated config.
   * @param context - The agent's identity, privileges and game access.
   */
  constructor(config: CodeHarnessConfig, context: HarnessContext) {
    super(config, context);
    this.#runner = new CodeRunner(config.helpers);
  }

  /** Clears the `state` object the code keeps between calls. */
  override reset(): void {
    this.#runner.reset();
  }

  protected defaultToolNames(): readonly ToolName[] {
    return CODE_TOOLS;
  }

  protected override createTool(name: ToolName): Tool {
    if (name === ToolName.RUN_CODE) {
      const { defaultTimeoutSeconds, maxTimeoutSeconds, toolOutputMaxChars } = this.config;
      return new RunCodeTool(this.#runner, {
        defaultTimeoutSeconds,
        maxTimeoutSeconds,
        outputMaxChars: toolOutputMaxChars,
        commands: this.config.commands,
      });
    }
    return super.createTool(name);
  }

  protected describeActionSpace(): string {
    const { helpers, defaultTimeoutSeconds, maxTimeoutSeconds } = this.config;
    const skills = helpers
      ? `\n\n${describeCodeSkills()}`
      : "\n\nThere is no helper library: use the Mineflayer API directly.";
    const commands = this.config.commands
      ? "\n  commands.run(command)  run a server command as yourself; returns the reply"
      : "";
    return `Action space (code): you act mainly by writing JavaScript with run_code. The code is the body of an async function and runs against your live Mineflayer bot (Mineflayer 4.39, Minecraft 1.21.11).

Globals:
  bot        the Mineflayer bot (full API: bot.entity.position, bot.blockAt(vec3), bot.placeBlock, bot.dig, bot.inventory, bot.pathfinder, ...)
  Vec3       new Vec3(x, y, z)
  mcData     minecraft-data for 1.21.11 (mcData.blocksByName, mcData.itemsByName, recipes)
  Item       prismarine-item; in creative: await bot.creative.setInventorySlot(36, new Item(mcData.itemsByName.stone.id, 64)) puts 64 stone in the first hotbar slot
  goals, Movements   mineflayer-pathfinder (the pathfinder plugin is loaded: await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)))
  state      an object kept between run_code calls of this run; store helpers and plans on it
  log(...)   output you will see (console.log works too); return a value to see it as well
  sleep(ms), isCancelled(), signal${commands}${skills}

Rules:
- Use await on every asynchronous call. Do not leave promises running; do not use setInterval.
- Each call has a time limit (default ${defaultTimeoutSeconds} s, at most ${maxTimeoutSeconds} s via timeout_seconds). When it passes, or the owner says stop, the call is cancelled: further use of bot or skills throws.
- Long synchronous loops freeze the bot; loops that run more than about two seconds must await something (for example await sleep(0)).
- Listeners you add with bot.on/once are removed when the call ends.
- Log what you verified (read the world back), not what you intended. A thrown error shows its line number.`;
  }
}

HARNESS_REGISTRY.register(HarnessName.CODE, {
  configSchema: CodeHarnessConfigSchema,
  create: (config, context) => new CodeHarness(CodeHarnessConfigSchema.parse(config), context),
});
