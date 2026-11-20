import type { z } from "zod";

import type { ToolCallItem, ToolOutputItem } from "../llm/types.ts";
import type { EventPublisher } from "../observability/event-bus.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import { runWithLimits } from "../utils/abort.ts";
import { ActionError, errorMessage, isAbortError, TimeoutError } from "../utils/errors.ts";
import { truncateMiddle } from "../utils/text.ts";

/** Everything in a {@link ToolContext} except what changes per call. */
export type ToolContextBase = Omit<ToolContext, "signal" | "callId" | "progress">;

/** The outcome of one call: the item for the model and whether the run should treat it as failed. */
export interface ExecutedCall {
  readonly output: ToolOutputItem;
  readonly ok: boolean;
  /** True when the call was cut short by `!stop` or shutdown. */
  readonly aborted: boolean;
}

/**
 * Runs the model's tool calls: parses and validates arguments, applies the tool's time limit and the
 * owner's abort signal, turns failures into error results the model can read, and publishes
 * `tool.started`, `tool.progress` and `tool.finished` events.
 */
export class ToolExecutor {
  readonly #tools: ReadonlyMap<string, Tool>;
  readonly #events: EventPublisher;
  readonly #outputMaxChars: number;

  /**
   * @param tools - The harness's tools.
   * @param events - Publishes tool events for the agent's run.
   * @param outputMaxChars - Outputs longer than this are cut in the middle.
   */
  constructor(tools: readonly Tool[], events: EventPublisher, outputMaxChars: number) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#events = events;
    this.#outputMaxChars = outputMaxChars;
  }

  /** Executes one call. Never throws; every failure becomes an error result. */
  async execute(call: ToolCallItem, base: ToolContextBase, signal: AbortSignal): Promise<ExecutedCall> {
    const started = performance.now();
    const tool = this.#tools.get(call.name);
    const parsedArguments = parseJson(call.arguments);
    this.#events.emit("tool.started", {
      callId: call.callId,
      name: call.name,
      arguments: parsedArguments.value ?? call.arguments,
    });

    let result: ToolResult;
    let aborted = false;
    if (tool === undefined) {
      result = {
        output: `Unknown tool "${call.name}". Available: ${[...this.#tools.keys()].join(", ")}.`,
        isError: true,
      };
    } else if (parsedArguments.error !== undefined) {
      result = {
        output: `The arguments are not valid JSON (${parsedArguments.error}). Call ${call.name} again.`,
        isError: true,
      };
    } else {
      const validated = tool.parameters.safeParse(parsedArguments.value);
      if (!validated.success) {
        result = { output: `Invalid arguments for ${call.name}: ${describeIssues(validated.error)}`, isError: true };
      } else {
        ({ result, aborted } = await this.#run(tool, validated.data, call, base, signal));
      }
    }

    const output = truncateMiddle(result.output, this.#outputMaxChars);
    const ok = result.isError !== true;
    const durationMs = Math.round(performance.now() - started);
    this.#events.emit("tool.finished", {
      callId: call.callId,
      name: call.name,
      ok,
      output,
      durationMs,
      ...(result.data === undefined ? {} : { data: result.data }),
    });
    return { output: { kind: "tool_output", callId: call.callId, output, isError: !ok }, ok, aborted };
  }

  /** The result reported for a call that was never started because an earlier call was stopped or failed. */
  skipped(call: ToolCallItem, reason: string): ExecutedCall {
    const output = `Not run: ${reason}`;
    this.#events.emit("tool.finished", { callId: call.callId, name: call.name, ok: false, output, durationMs: 0 });
    return { output: { kind: "tool_output", callId: call.callId, output, isError: true }, ok: false, aborted: false };
  }

  async #run(
    tool: Tool,
    args: z.infer<z.ZodObject>,
    call: ToolCallItem,
    base: ToolContextBase,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; aborted: boolean }> {
    try {
      const result = await runWithLimits(
        (limitSignal) =>
          tool.execute(args, {
            ...base,
            signal: AbortSignal.any([signal, limitSignal]),
            callId: call.callId,
            progress: (message) => {
              this.#events.emit("tool.progress", { callId: call.callId, name: call.name, message });
            },
          }),
        { timeoutMs: tool.timeoutMs, signal, label: call.name },
      );
      return { result, aborted: false };
    } catch (error) {
      if (isAbortError(error)) {
        return { result: { output: "Stopped by the owner before it finished.", isError: true }, aborted: true };
      }
      if (error instanceof TimeoutError) {
        return {
          result: {
            output: `${call.name} did not finish within ${tool.timeoutMs / 1000} s and was stopped.`,
            isError: true,
          },
          aborted: false,
        };
      }
      if (error instanceof ActionError) {
        return { result: { output: `Failed: ${error.message}`, isError: true }, aborted: false };
      }
      return {
        result: {
          output: `Failed with an unexpected error: ${errorMessage(error)}`,
          isError: true,
          data: { stack: stackOf(error) },
        },
        aborted: false,
      };
    }
  }
}

function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: text.trim() === "" ? {} : (JSON.parse(text) as unknown) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(arguments)"}: ${issue.message}`).join("; ");
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
