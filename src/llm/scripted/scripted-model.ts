import { z } from "zod";

import { ProviderName } from "../../utils/names.ts";
import { LanguageModel, ModelConfigSchema, type ProviderResult } from "../language-model.ts";
import { PROVIDER_REGISTRY } from "../registry.ts";
import { emptyUsage, StopReason, type ConversationItem, type ModelRequest } from "../types.ts";

/** One scripted model response: tool calls to request, or a final text. */
const ScriptStepSchema = z.strictObject({
  /** Visible text for this step. A step with text and no calls ends the turn. */
  text: z.string().default(""),
  /** Tool calls to request, with their arguments as objects. */
  calls: z.array(z.strictObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })).default([]),
});

/** Config of a scripted model. */
export const ScriptedModelConfigSchema = ModelConfigSchema.extend({
  provider: z.literal(ProviderName.SCRIPTED),
  /** The responses to give, in order. Each owner message starts again from the first step. */
  script: z.array(ScriptStepSchema).min(1),
});

/** See {@link ScriptedModelConfigSchema}. */
export type ScriptedModelConfig = z.infer<typeof ScriptedModelConfigSchema>;

/**
 * A {@link LanguageModel} that replays a fixed script instead of calling an API.
 *
 * It lets the whole lab (chat, tools, logging, dashboard) run against a real server without spending
 * money, and it makes the agent loop testable. Each turn replays the script from the first step; the
 * step index is the number of model calls since the latest user message.
 */
export class ScriptedModel extends LanguageModel<ScriptedModelConfig> {
  protected call(request: ModelRequest): Promise<ProviderResult> {
    const lastUser = findLastIndex(request.items, (item) => item.kind === "user");
    const stepIndex = countToolRounds(request.items.slice(lastUser + 1));
    const step = this.config.script[stepIndex];
    const items: ConversationItem[] = [];
    if (step === undefined) {
      items.push({ kind: "assistant", text: "Script finished." });
      return Promise.resolve(this.#result(items, StopReason.END_TURN));
    }
    if (step.text !== "") {
      items.push({ kind: "assistant", text: step.text });
    }
    step.calls.forEach((call, index) => {
      items.push({
        kind: "tool_call",
        callId: `scripted_${String(stepIndex)}_${String(index)}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    });
    return Promise.resolve(this.#result(items, step.calls.length > 0 ? StopReason.TOOL_CALLS : StopReason.END_TURN));
  }

  #result(items: ConversationItem[], stopReason: StopReason): ProviderResult {
    return { items, usage: emptyUsage(), stopReason, servedModel: "scripted" };
  }
}

/** Number of completed tool rounds in `items`: each run of consecutive tool outputs is one round. */
function countToolRounds(items: readonly ConversationItem[]): number {
  let rounds = 0;
  let previous: ConversationItem["kind"] | undefined;
  for (const item of items) {
    if (item.kind === "tool_output" && previous !== "tool_output") {
      rounds += 1;
    }
    previous = item.kind;
  }
  return rounds;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) {
      return index;
    }
  }
  return -1;
}

PROVIDER_REGISTRY.register(ProviderName.SCRIPTED, {
  configSchema: ScriptedModelConfigSchema,
  create: (config) => new ScriptedModel(ScriptedModelConfigSchema.parse(config)),
});
