import { z } from "zod";

import type { Privileges } from "../agent/privileges.ts";
import type { GameServices } from "../minecraft/game-services.ts";
import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import { RequestItemsTool, type ItemRequestMode } from "../tools/inventory/request-items-tool.ts";
import { createRegisteredTool } from "../tools/registry.ts";
import type { Tool } from "../tools/tool.ts";
import { HarnessName, ToolName } from "../utils/names.ts";

/** Fields every harness config has. Harness configs live in `configs/harnesses/<preset>.yaml`. */
export const HarnessConfigSchema = z.strictObject({
  /** Which harness class to build. */
  harness: z.enum(Object.values(HarnessName) as [HarnessName, ...HarnessName[]]),
  /** One line shown in listings, for example "one game action per tool call". */
  description: z.string().default(""),
  /** Replace the harness's default tools with exactly these (privilege tools are still added). */
  tools: z.array(z.enum(Object.values(ToolName) as [ToolName, ...ToolName[]])).optional(),
  /** Remove these tools from the default set, for ablations. */
  excludeTools: z.array(z.enum(Object.values(ToolName) as [ToolName, ...ToolName[]])).default([]),
  /** Tool output longer than this is cut in the middle before the model sees it. */
  toolOutputMaxChars: z.int().positive().default(8_000),
  /** Attach the bot's status and the owner's position to every owner message. */
  observeOnMessage: z.boolean().default(true),
  /** Extra text appended to the system prompt, for prompt experiments. */
  promptAppendix: z.string().default(""),
  /**
   * Survival only: how `request_items` works. `automatic` gives requested items at once, `approval`
   * waits for the owner's `!approve` or `!deny`, `off` removes the tool so everything must be gathered.
   */
  itemRequests: z.enum(["automatic", "approval", "off"]).default("automatic"),
  /**
   * Give the model server commands: the `run_command` tool, and `commands.run` in the code harness. With
   * `/fill` and `/setblock` it can place thousands of blocks per call, which also bypasses survival rules.
   */
  commands: z.boolean().default(false),
});

/** See {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

/** What a harness can reach. The game layer is read through a getter because it is rebuilt on reconnect. */
export interface HarnessContext {
  readonly agentName: string;
  readonly owners: readonly string[];
  readonly privileges: Privileges;
  readonly server: ServerControl;
  /** The current connection's game layer. Throws when the bot is not connected. */
  game(): GameServices;
}

/**
 * Base class for a harness: the action space and instructions a model gets to play the game.
 *
 * A harness decides which tools the model sees and how the system prompt describes them. Everything
 * else (the agent loop, chat, budgets, logging) is shared, so two runs that differ only in harness
 * measure the harness.
 *
 * Subclasses implement {@link defaultToolNames} and {@link describeActionSpace}. The template methods
 * {@link tools} and {@link instructions} apply the config filters, privileges and shared prompt text,
 * and are not meant to be overridden.
 *
 * @typeParam C - The harness's config type.
 */
export abstract class Harness<C extends HarnessConfig = HarnessConfig> {
  /** The registry name of the harness class. */
  abstract readonly name: HarnessName;
  readonly config: C;
  protected readonly context: HarnessContext;
  #tools: Tool[] | undefined;

  /**
   * @param config - Validated harness config.
   * @param context - The agent's identity, privileges and game access.
   */
  constructor(config: C, context: HarnessContext) {
    this.config = config;
    this.context = context;
  }

  /**
   * The tools the model can call: the configured or default tool names minus exclusions, then the
   * privilege tools, in a fixed order.
   *
   * The list is built once and then reused, because changing tools mid-run breaks the provider's prompt cache.
   */
  tools(): readonly Tool[] {
    this.#tools ??= this.#buildToolList();
    return this.#tools;
  }

  /** The system prompt: shared rules, this harness's action space, privileges, and the config appendix. */
  instructions(): string {
    const sections = [
      sharedRules(this.context.agentName, this.context.owners),
      this.describeActionSpace(),
      describePrivileges(this.context.privileges, this.#itemRequestMode(), this.config.commands),
      this.config.promptAppendix,
    ];
    return sections.filter((section) => section.trim().length > 0).join("\n\n");
  }

  /** Called when the run is reset with `!reset`. Harnesses with state (the code harness) clear it here. */
  reset(): void {
    // Stateless by default.
  }

  /** Releases resources when the agent shuts down. */
  dispose(): void {
    // Nothing to release by default.
  }

  /** Names of the tools this harness offers when its config does not list them. */
  protected abstract defaultToolNames(): readonly ToolName[];

  /** The harness-specific part of the system prompt: how to act in the game through these tools. */
  protected abstract describeActionSpace(): string;

  /** Builds one tool. Harnesses whose tools need constructor arguments (the code harness) override this. */
  protected createTool(name: ToolName): Tool {
    const itemRequests = this.#itemRequestMode();
    if (name === ToolName.REQUEST_ITEMS && itemRequests !== null) {
      return new RequestItemsTool(itemRequests);
    }
    return createRegisteredTool(name);
  }

  /**
   * Tools added for privileges: `give_item` in creative mode, `request_items` in survival (unless the
   * preset turns item requests off), `run_command` when the preset gives server commands.
   */
  protected privilegeToolNames(): ToolName[] {
    const names: ToolName[] = [];
    if (this.context.privileges.gameMode === "creative") {
      names.push(ToolName.GIVE_ITEM);
    }
    if (this.#itemRequestMode() !== null) {
      names.push(ToolName.REQUEST_ITEMS);
    }
    if (this.config.commands) {
      names.push(ToolName.RUN_COMMAND);
    }
    return names;
  }

  /** How `request_items` behaves, or null when the bot does not get the tool (creative mode, or turned off). */
  #itemRequestMode(): ItemRequestMode | null {
    const mode = this.config.itemRequests;
    return this.context.privileges.gameMode === "survival" && mode !== "off" ? mode : null;
  }

  #buildToolList(): Tool[] {
    const excluded = new Set<ToolName>(this.config.excludeTools);
    const configured = (this.config.tools ?? this.defaultToolNames()).filter((name) => !excluded.has(name));
    const names = [...new Set([...configured, ...this.privilegeToolNames()])];
    return names.map((name) => this.createTool(name));
  }
}

/** Rules that hold for every harness. Kept identical across harnesses so runs stay comparable. */
function sharedRules(agentName: string, owners: readonly string[]): string {
  const ownerList = owners.join(", ");
  return `You are ${agentName}, a player in a Minecraft Java Edition 1.21.11 world, controlled through tools.
Your owner (${ownerList}) is in the same world and gives you tasks in chat. Messages from the owner arrive as user messages, with a status line showing where you and they are.

How to work:
- Act through tool calls. Never describe an action instead of doing it.
- Coordinates are absolute world coordinates as shown by F3: x increases to the east, y up, z to the south. North is -z.
- Look before you act and check the result after: tools report what is true afterwards; read their output.
- Before a build, decide its origin, size and orientation in absolute coordinates. Build from the lowest layer up; blocks need a neighbouring block to be placed against.
- "Here", "this" or "where I am" refer to the owner's position or the block they are looking at, given in the status line.
- If a message arrives while you are working, it is the owner steering you: adjust your plan accordingly.
- When the task is done, or you cannot continue, reply with a short final message saying what you did and what you verified. That reply is sent to the owner in chat; keep it under 250 characters.
- Be honest about failures and partial results.`;
}

/** Prompt text describing the agent's privileges and, in survival, how it can get items. */
function describePrivileges(privileges: Privileges, itemRequests: ItemRequestMode | null, commands: boolean): string {
  const survivalItems =
    itemRequests === "automatic"
      ? "You can get items you need with request_items; they are given to you at once."
      : itemRequests === "approval"
        ? "You can ask the owner for items with request_items; they approve or deny each request. Otherwise you must gather or craft every block and item you use."
        : "You must gather or craft every block and item you use.";
  const mode =
    privileges.gameMode === "creative"
      ? "You are in creative mode: you can fly, break blocks instantly, and any placeable item is available without gathering it."
      : `You are in survival mode and can take damage. ${survivalItems}`;
  const commandText = commands
    ? "You may run server commands with the run_command tool (for example /fill, /setblock, /clone, /give)."
    : "You cannot run server commands.";
  return `Privileges: ${mode} ${commandText}`;
}
