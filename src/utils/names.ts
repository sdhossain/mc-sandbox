/**
 * Canonical names used as registry keys, config values and event fields.
 *
 * Each name set is a frozen const object plus a union type of its values. This replaces TypeScript
 * `enum`, which Node's native type stripping cannot run.
 */

/** Values of a const name object, as a union type. */
export type ValueOf<T> = T[keyof T];

/** The harness levels of the ladder, from least to most model leverage. */
export const HarnessName = {
  /** One atomic game action per tool call. */
  PRIMITIVE: "primitive",
  /** Primitive tools plus multi-step skills such as batch building and gathering. */
  SKILLS: "skills",
  /** The model writes JavaScript that runs against the live Mineflayer bot. */
  CODE: "code",
} as const;
export type HarnessName = ValueOf<typeof HarnessName>;

/** Model provider adapters. */
export const ProviderName = {
  /** OpenAI Responses API. */
  OPENAI: "openai",
  /** Any Chat Completions compatible endpoint (OpenAI, OpenRouter, vLLM, Ollama). */
  OPENAI_CHAT: "openai-chat",
  /** A deterministic model that replays a script. Used by tests and dry runs. */
  SCRIPTED: "scripted",
} as const;
export type ProviderName = ValueOf<typeof ProviderName>;

/** Game modes the lab can put a bot in. */
export const GameMode = {
  SURVIVAL: "survival",
  CREATIVE: "creative",
  ADVENTURE: "adventure",
  SPECTATOR: "spectator",
} as const;
export type GameMode = ValueOf<typeof GameMode>;

/** How a turn ended. */
export const TurnStatus = {
  /** The model answered without requesting more tool calls. */
  COMPLETED: "completed",
  /** The owner stopped the agent with `!stop`, `!reset` or the dashboard. */
  STOPPED: "stopped",
  /** A step, time or cost budget ran out. */
  BUDGET_EXCEEDED: "budget_exceeded",
  /** The model call or the agent loop failed. */
  FAILED: "failed",
} as const;
export type TurnStatus = ValueOf<typeof TurnStatus>;

/** How a run ended. A run is one conversation, from agent start or `!reset` to the next reset or shutdown. */
export const RunStatus = {
  RUNNING: "running",
  ENDED: "ended",
  RESET: "reset",
  CRASHED: "crashed",
} as const;
export type RunStatus = ValueOf<typeof RunStatus>;

/** Where a task or steering message came from. */
export const MessageSource = {
  CHAT: "chat",
  WHISPER: "whisper",
  DASHBOARD: "dashboard",
  CLI: "cli",
  /** A failure case's task, sent by `!case` on the owner's behalf. */
  CASE: "case",
  /** An unattended trial's automatic answer to a question the model ended its turn with. */
  TRIAL: "trial",
} as const;
export type MessageSource = ValueOf<typeof MessageSource>;

/** Every tool the harnesses can expose. Harness configs refer to tools by these names. */
export const ToolName = {
  // Perception
  OBSERVE: "observe",
  INSPECT_REGION: "inspect_region",
  FIND_BLOCKS: "find_blocks",
  LIST_ENTITIES: "list_entities",
  BLOCK_INFO: "block_info",
  // Movement
  GO_TO: "go_to",
  GO_TO_PLAYER: "go_to_player",
  LOOK_AT: "look_at",
  STOP_MOVING: "stop_moving",
  // Building
  PLACE_BLOCK: "place_block",
  DIG_BLOCK: "dig_block",
  // Inventory
  EQUIP: "equip",
  TOSS: "toss",
  GIVE_ITEM: "give_item",
  REQUEST_ITEMS: "request_items",
  // Crafting
  CRAFT: "craft",
  SMELT: "smelt",
  // Interaction
  ACTIVATE_BLOCK: "activate_block",
  USE_ITEM_ON: "use_item_on",
  CONTAINER_TRANSFER: "container_transfer",
  CONSUME: "consume",
  ATTACK: "attack",
  RUN_COMMAND: "run_command",
  // Communication and control
  CHAT: "chat",
  WAIT: "wait",
  // Skills
  BUILD_STRUCTURE: "build_structure",
  FILL_REGION: "fill_region",
  CLEAR_REGION: "clear_region",
  COLLECT_BLOCKS: "collect_blocks",
  CRAFT_WITH_INGREDIENTS: "craft_with_ingredients",
  FARM_PLOT: "farm_plot",
  // Code
  RUN_CODE: "run_code",
} as const;
export type ToolName = ValueOf<typeof ToolName>;

/** Returns true when `value` is one of the values of the const name object `names`. */
export function isNameOf<T extends Record<string, string>>(names: T, value: string): value is ValueOf<T> {
  return Object.values<string>(names).includes(value);
}
