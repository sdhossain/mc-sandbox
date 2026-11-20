import { z } from "zod";

import type { ApprovalDesk } from "../agent/approval-desk.ts";
import type { Privileges } from "../agent/privileges.ts";
import type { JsonSchema, ToolSpec } from "../llm/types.ts";
import type { GameServices } from "../minecraft/game-services.ts";
import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import type { ToolName } from "../utils/names.ts";

/** Everything a tool needs while it runs. Built fresh for every call. */
export interface ToolContext {
  /** Name of the agent (and of its bot). */
  readonly agentName: string;
  /** The connected bot's game layer. */
  readonly game: GameServices;
  /** The lab's operator channel. */
  readonly server: ServerControl;
  readonly privileges: Privileges;
  /** Aborts when the owner stops the agent or the call times out. */
  readonly signal: AbortSignal;
  /** The model's id for this call. */
  readonly callId: string;
  /** The run's output directory, for tools that save artifacts (for example executed code). */
  readonly runDir: string;
  /** Asks the owner to approve something and waits for `!approve` or `!deny`. */
  readonly approvals: ApprovalDesk;
  /** Reports progress, shown live on the dashboard and in the owner's status line. */
  progress(message: string): void;
}

/** What a tool returns. */
export interface ToolResult {
  /** Text for the model. Say what happened and what is true now, not what was intended. */
  readonly output: string;
  /** Marks a failed call. The model sees the output either way. */
  readonly isError?: boolean;
  /** Structured details for the trace and the dashboard. Never sent to the model. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Base class for a tool the model can call.
 *
 * A subclass declares its name, a description written for the model, and a zod schema for its
 * arguments, then implements {@link execute}. The tool executor validates arguments against the schema
 * before calling {@link execute}, applies the time limit, and turns thrown `ActionError`s into error
 * results, so `execute` only handles the success path and expected failures.
 *
 * Optional arguments must be declared `.nullable()` rather than `.optional()`: OpenAI's strict mode
 * requires every property, and the model passes `null` for "not given".
 *
 * @typeParam S - The zod schema of the arguments object.
 */
export abstract class Tool<S extends z.ZodObject = z.ZodObject> {
  /** The name the model calls the tool by. */
  abstract readonly name: ToolName;
  /** What the tool does, when to use it, and what it returns. Written for the model. */
  abstract readonly description: string;
  /** The arguments, as a zod object schema. */
  abstract readonly parameters: S;
  /** Default time limit for one call. Tools that run long (building, gathering) raise it. */
  readonly timeoutMs: number = 120_000;

  /**
   * Carries out the call.
   *
   * @param args - Arguments already validated against {@link parameters}.
   * @param context - The bot, the lab and the abort signal for this call.
   * @throws ActionError for expected failures; the executor reports the message to the model.
   */
  abstract execute(args: z.infer<S>, context: ToolContext): Promise<ToolResult>;

  /** Describes the tool for the model provider. */
  spec(): ToolSpec {
    return { name: this.name, description: this.description, parameters: toToolJsonSchema(this.parameters) };
  }
}

/**
 * Converts a zod object schema into a JSON Schema that OpenAI's strict mode accepts.
 *
 * Strict mode requires `additionalProperties: false` on every object and every property listed in
 * `required`, at every nesting level. Optional arguments are therefore declared nullable, never
 * optional; this function enforces the rest and removes the `$schema` key.
 */
export function toToolJsonSchema(schema: z.ZodObject): JsonSchema {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as JsonSchema;
  delete json.$schema;
  return makeStrict(json);
}

/** Applies strict-mode object rules to `node` and everything nested in it. */
function makeStrict(node: JsonSchema): JsonSchema {
  // zod emits the safe-integer range on every z.int(); it says nothing and costs prompt tokens.
  if (node.minimum === Number.MIN_SAFE_INTEGER) {
    delete node.minimum;
  }
  if (node.maximum === Number.MAX_SAFE_INTEGER) {
    delete node.maximum;
  }
  const properties = node.properties as Record<string, JsonSchema> | undefined;
  if (properties !== undefined) {
    node.additionalProperties = false;
    node.required = Object.keys(properties);
    for (const child of Object.values(properties)) {
      makeStrict(child);
    }
  }
  for (const key of ["items", "anyOf", "oneOf", "prefixItems"] as const) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value as JsonSchema[]) {
        makeStrict(child);
      }
    } else if (typeof value === "object" && value !== null) {
      makeStrict(value as JsonSchema);
    }
  }
  return node;
}
