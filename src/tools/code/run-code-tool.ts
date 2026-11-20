import { z } from "zod";

import type { CodeResult, CodeRunner } from "../../harness/code/code-runner.ts";
import { ToolName } from "../../utils/names.ts";
import { formatDuration, truncateMiddle } from "../../utils/text.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const RunCodeArgs = z.strictObject({
  code: z.string().min(1).describe("JavaScript: the body of an async function. Use await; return a value to see it."),
  timeout_seconds: z.int().min(1).max(3600).nullable().describe("Time limit for this call; null for the default."),
});

/** How the code harness sets up {@link RunCodeTool}. */
export interface RunCodeSettings {
  /** Time limit when the model gives none. */
  readonly defaultTimeoutSeconds: number;
  /** The longest time limit the model may ask for. */
  readonly maxTimeoutSeconds: number;
  /** Logs longer than this are cut in the middle. */
  readonly outputMaxChars: number;
  /** Give the code `commands.run` for server commands. */
  readonly commands: boolean;
}

/** Runs model-written JavaScript against the live bot. Built by the code harness, which owns the runner. */
export class RunCodeTool extends Tool<typeof RunCodeArgs> {
  readonly name = ToolName.RUN_CODE;
  readonly description =
    "Run JavaScript against your live Mineflayer bot. The code is the body of an async function; see the system prompt for the globals. Returns the logs, the returned value, or the error with its line number.";
  readonly parameters = RunCodeArgs;
  override readonly timeoutMs: number;
  readonly #runner: CodeRunner;
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #outputMaxChars: number;
  readonly #commands: boolean;

  /**
   * @param runner - The harness's runner (it holds `state` between calls).
   * @param settings - Time limits, output size and whether code may run server commands.
   */
  constructor(runner: CodeRunner, settings: RunCodeSettings) {
    super();
    this.#runner = runner;
    this.#defaultTimeoutMs = settings.defaultTimeoutSeconds * 1000;
    this.#maxTimeoutMs = settings.maxTimeoutSeconds * 1000;
    this.#outputMaxChars = settings.outputMaxChars;
    this.#commands = settings.commands;
    this.timeoutMs = this.#maxTimeoutMs + 30_000;
  }

  /** Runs the code. */
  async execute(args: z.infer<typeof RunCodeArgs>, context: ToolContext): Promise<ToolResult> {
    const requested = args.timeout_seconds === null ? this.#defaultTimeoutMs : args.timeout_seconds * 1000;
    const result = await this.#runner.run(args.code, {
      game: context.game,
      server: context.server,
      agentName: context.agentName,
      commands: this.#commands,
      timeoutMs: Math.min(requested, this.#maxTimeoutMs),
      signal: context.signal,
      progress: (message) => {
        context.progress(message);
      },
    });
    return { output: this.#describe(result), isError: !result.ok, data: { code: args.code, ...result } };
  }

  #describe(result: CodeResult): string {
    const head = result.ok
      ? `Finished in ${formatDuration(result.durationMs)}.`
      : result.timedOut
        ? `Timed out after ${formatDuration(result.durationMs)} and was cancelled. ${result.error ?? ""}`
        : `Failed after ${formatDuration(result.durationMs)}: ${result.error ?? "unknown error"}`;
    const logs =
      result.logs.length === 0 ? "" : `\nLogs:\n${truncateMiddle(result.logs.join("\n"), this.#outputMaxChars)}`;
    const returned =
      result.returned === null ? "" : `\nReturned: ${truncateMiddle(result.returned, this.#outputMaxChars / 2)}`;
    return `${head}${logs}${returned}`;
  }
}
