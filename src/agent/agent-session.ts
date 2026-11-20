import type { Harness } from "../harness/harness.ts";
import type { LanguageModel } from "../llm/language-model.ts";
import { addUsage, emptyUsage, type ConversationItem, type ToolCallItem, type ToolSpec } from "../llm/types.ts";
import type { GameServices } from "../minecraft/game-services.ts";
import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import { formatPosition, type PlayerInfo } from "../minecraft/types.ts";
import type { EventPublisher } from "../observability/event-bus.ts";
import { toLoggedItems, type Totals } from "../observability/events.ts";
import { errorMessage, isAbortError, ModelError } from "../utils/errors.ts";
import { TurnStatus } from "../utils/names.ts";
import { formatUsd } from "../utils/text.ts";
import { TurnBudget, type BudgetConfig } from "./budget.ts";
import { Inbox, type OwnerMessage } from "./inbox.ts";
import type { Privileges } from "./privileges.ts";
import type { ApprovalDesk } from "./approval-desk.ts";
import { ToolExecutor } from "./tool-executor.ts";

/** What a session needs from its agent. */
export interface AgentSessionOptions {
  readonly name: string;
  readonly owners: readonly string[];
  readonly model: LanguageModel;
  readonly harness: Harness;
  readonly budget: BudgetConfig;
  readonly privileges: Privileges;
  readonly server: ServerControl;
  readonly events: EventPublisher;
  /** Where tools ask the owner for approval. */
  readonly approvals: ApprovalDesk;
  /** The current game layer; throws while the bot is disconnected. */
  game(): GameServices;
  /** The current run's directory, for tools that save artifacts. */
  runDir(): string;
  /** Sends the turn's final reply to the owner. */
  reply(text: string, to: OwnerMessage): Promise<void>;
  /** Called when a turn starts, before the first model call. */
  onTurnStart?(turn: number): void;
  /** Called when a turn ends, after the reply. */
  onTurnEnd?(turn: number, outcome: TurnOutcome): void;
}

/** How a finished turn went. */
export interface TurnOutcome {
  readonly status: TurnStatus;
  readonly reason: string;
  readonly finalText: string;
}

/**
 * The agent loop for one run: owner message in, model calls and tool calls until the model answers,
 * reply out.
 *
 * One turn = one owner message (plus any steering messages that arrive during it). One step = one
 * model call plus the tool calls it requested, executed in order. The conversation is append-only
 * for the whole run, so the provider's prompt cache stays valid and the trace is complete.
 */
export class AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #executor: ToolExecutor;
  readonly #toolSpecs: readonly ToolSpec[];
  readonly #inbox = new Inbox();
  #items: ConversationItem[] = [];
  #loggedUpTo = 0;
  #turn = 0;
  #totals: Totals = emptyTotals();
  #turnController: AbortController | null = null;
  #current: { readonly turn: number; readonly step: number; readonly tool: string | null } | null = null;

  /** @param options - The agent's model, harness, budget and game access. */
  constructor(options: AgentSessionOptions) {
    this.#options = options;
    this.#toolSpecs = options.harness.tools().map((tool) => tool.spec());
    this.#executor = new ToolExecutor(
      options.harness.tools(),
      options.events,
      options.harness.config.toolOutputMaxChars,
    );
  }

  /** The tools as described to the model. */
  get toolSpecs(): readonly ToolSpec[] {
    return this.#toolSpecs;
  }

  /** Totals for the run so far. */
  get totals(): Totals {
    return this.#totals;
  }

  /** True while a turn is running. */
  get busy(): boolean {
    return this.#turnController !== null;
  }

  /** Queues an owner message; a running turn receives it at its next step. */
  deliver(message: OwnerMessage): void {
    if (this.busy) {
      this.#options.events.emit("message.queued", {
        source: message.source,
        from: message.from,
        message: message.text,
      });
    }
    this.#inbox.push(message);
  }

  /** Aborts the running turn, if any: the model call or tool in progress stops at once. */
  stopTurn(reason: string): void {
    this.#turnController?.abort(new Error(reason));
  }

  /** Clears the conversation for a new run and drops queued messages. Call only while idle. */
  resetConversation(): void {
    this.#items = [];
    this.#loggedUpTo = 0;
    this.#turn = 0;
    this.#totals = emptyTotals();
    this.#inbox.drain();
  }

  /** One line describing what the agent is doing, for `!status`. */
  describeStatus(): string {
    const totals = this.#totals;
    const activity =
      this.#current === null
        ? "idle"
        : `busy with turn ${this.#current.turn}, step ${this.#current.step}${this.#current.tool === null ? "" : `, running ${this.#current.tool}`}`;
    return `${this.#options.name} (${this.#options.model.id}, ${this.#options.harness.name}): ${activity}. Run so far: ${totals.turns} turns, ${totals.steps} steps, ${totals.toolCalls} tool calls, ${formatUsd(totals.costUsd)}.`;
  }

  /** Runs turns as messages arrive until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const messages = await this.#inbox.takeAll(signal);
      if (messages.length === 0) {
        continue;
      }
      await this.runTurn(messages);
    }
  }

  /** Runs one turn for `messages` (usually one; several when they queued up while idle). */
  async runTurn(messages: readonly OwnerMessage[]): Promise<TurnOutcome> {
    const first = messages[0];
    if (first === undefined) {
      throw new Error("runTurn needs at least one message");
    }
    const controller = new AbortController();
    this.#turnController = controller;
    this.#turn += 1;
    const turn = this.#turn;
    const { events } = this.#options;
    events.setOrigin({ turn, step: undefined });
    const delivered = this.#composeUserMessage(messages);
    this.#items.push({ kind: "user", text: delivered });
    events.emit("turn.started", {
      source: first.source,
      from: first.from,
      message: messages.map((message) => message.text).join("\n"),
      delivered,
    });
    this.#options.onTurnStart?.(turn);

    const budget = new TurnBudget(this.#options.budget, this.#totals.costUsd);
    const turnStart = { ...this.#totals };
    let outcome: TurnOutcome;
    try {
      outcome = await this.#loop(turn, budget, controller.signal);
    } catch (error) {
      outcome = { status: TurnStatus.FAILED, reason: `Agent error: ${errorMessage(error)}`, finalText: "" };
      events.emit("log", {
        level: "error",
        message: "Turn failed",
        detail: error instanceof Error ? error.stack : String(error),
      });
    } finally {
      this.#turnController = null;
      this.#current = null;
    }
    this.#totals = { ...this.#totals, turns: this.#totals.turns + 1 };
    events.setOrigin({ step: undefined });
    events.emit("turn.ended", {
      status: outcome.status,
      reason: outcome.reason,
      finalText: outcome.finalText,
      durationMs: Math.round(budget.elapsedMs),
      totals: difference(this.#totals, turnStart),
    });
    await this.#sendReply(outcome, first);
    this.#options.onTurnEnd?.(turn, outcome);
    events.setOrigin({ turn: undefined });
    return outcome;
  }

  async #loop(turn: number, budget: TurnBudget, signal: AbortSignal): Promise<TurnOutcome> {
    const { events, model, harness } = this.#options;
    const instructions = harness.instructions();
    for (;;) {
      const exceeded = budget.exceeded();
      if (exceeded !== null) {
        events.emit("budget.exceeded", exceeded);
        return {
          status: TurnStatus.BUDGET_EXCEEDED,
          reason: `${exceeded.budget} limit of ${exceeded.limit} reached`,
          finalText: "",
        };
      }
      if (signal.aborted) {
        return { status: TurnStatus.STOPPED, reason: "stopped by the owner", finalText: "" };
      }
      const step = budget.steps + 1;
      this.#current = { turn, step, tool: null };
      events.setOrigin({ step });
      events.emit("model.request", {
        itemCount: this.#items.length,
        newItems: toLoggedItems(this.#items.slice(this.#loggedUpTo)),
      });
      this.#loggedUpTo = this.#items.length;

      let response;
      try {
        response = await model.generate({
          instructions,
          items: this.#items,
          tools: this.#toolSpecs,
          signal,
          cacheKey: events.origin.runId,
        });
      } catch (error) {
        if (isAbortError(error) || wasAborted(signal)) {
          return { status: TurnStatus.STOPPED, reason: "stopped by the owner", finalText: "" };
        }
        const retryable = error instanceof ModelError && error.retryable;
        events.emit("model.error", { message: errorMessage(error), retryable });
        return { status: TurnStatus.FAILED, reason: `model call failed: ${errorMessage(error)}`, finalText: "" };
      }
      budget.recordStep(response.costUsd);
      this.#items.push(...response.items);
      this.#loggedUpTo = this.#items.length;
      this.#totals = {
        ...this.#totals,
        steps: this.#totals.steps + 1,
        usage: addUsage(this.#totals.usage, response.usage),
        costUsd: this.#totals.costUsd + response.costUsd,
      };
      events.emit("model.response", {
        items: toLoggedItems(response.items),
        usage: response.usage,
        costUsd: response.costUsd,
        latencyMs: response.latencyMs,
        stopReason: response.stopReason,
        servedModel: response.servedModel,
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        ...(response.diagnostics === undefined ? {} : { diagnostics: response.diagnostics }),
      });

      const calls = response.items.filter((item): item is ToolCallItem => item.kind === "tool_call");
      if (calls.length === 0) {
        const finalText = response.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text)
          .join("\n")
          .trim();
        return { status: TurnStatus.COMPLETED, reason: response.stopReason, finalText };
      }

      const stopped = await this.#executeCalls(turn, step, calls, signal);
      if (stopped) {
        return { status: TurnStatus.STOPPED, reason: "stopped by the owner", finalText: "" };
      }
      this.#deliverSteering();
    }
  }

  /** Runs the calls in order. After a failure the rest are skipped so the model can re-plan. Returns true if stopped. */
  async #executeCalls(
    turn: number,
    step: number,
    calls: readonly ToolCallItem[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const base = {
      agentName: this.#options.name,
      game: this.#options.game(),
      server: this.#options.server,
      privileges: this.#options.privileges,
      runDir: this.#options.runDir(),
      approvals: this.#options.approvals,
    };
    let skipReason: string | null = null;
    let stopped = false;
    for (const call of calls) {
      if (signal.aborted) {
        skipReason = "the owner stopped the task.";
        stopped = true;
      }
      if (skipReason !== null) {
        this.#items.push(this.#executor.skipped(call, skipReason).output);
        continue;
      }
      this.#current = { turn, step, tool: call.name };
      const executed = await this.#executor.execute(call, base, signal);
      this.#items.push(executed.output);
      this.#totals = {
        ...this.#totals,
        toolCalls: this.#totals.toolCalls + 1,
        toolErrors: this.#totals.toolErrors + (executed.ok ? 0 : 1),
      };
      if (executed.aborted) {
        skipReason = "the owner stopped the task.";
        stopped = true;
      } else if (!executed.ok && calls.length > 1) {
        skipReason = `an earlier call in this response (${call.name}) failed.`;
      }
    }
    return stopped;
  }

  /** Hands messages that arrived during the step to the model as user messages. */
  #deliverSteering(): void {
    for (const message of this.#inbox.drain()) {
      this.#items.push({ kind: "user", text: `${message.from} (while you were working): ${message.text}` });
      this.#options.events.emit("message.delivered", { from: message.from, message: message.text });
    }
  }

  /** The owner's words plus a status line, so "here" and "this" can be resolved. */
  #composeUserMessage(messages: readonly OwnerMessage[]): string {
    const lines = messages.map((message) => `${message.from}: ${message.text}`);
    if (!this.#options.harness.config.observeOnMessage) {
      return lines.join("\n");
    }
    return [...lines, "", this.#statusLine(messages[0]?.from)].join("\n");
  }

  #statusLine(owner: string | undefined): string {
    try {
      const { scanner } = this.#options.game();
      const status = scanner.status();
      const self = `you are at ${formatPosition(status.position)} facing ${status.facing}, holding ${status.heldItem ?? "nothing"}, ${status.gameMode} mode`;
      const ownerInfo = owner === undefined ? null : scanner.player(owner);
      return `[Status: ${self}; ${describeOwner(owner, ownerInfo)}]`;
    } catch (error) {
      return `[Status unavailable: ${errorMessage(error)}]`;
    }
  }

  async #sendReply(outcome: TurnOutcome, to: OwnerMessage): Promise<void> {
    let text = outcome.finalText;
    if (outcome.status === TurnStatus.STOPPED) {
      text = "Stopped.";
    } else if (outcome.status === TurnStatus.BUDGET_EXCEEDED) {
      text = `I stopped: the ${outcome.reason}. Say "continue" to go on.`;
    } else if (outcome.status === TurnStatus.FAILED) {
      text = `I hit an error: ${outcome.reason}`;
    } else if (text === "") {
      text = "Done.";
    }
    try {
      await this.#options.reply(text, to);
    } catch (error) {
      this.#options.events.emit("log", { level: "warn", message: `Could not send the reply: ${errorMessage(error)}` });
    }
  }
}

function describeOwner(owner: string | undefined, info: PlayerInfo | null): string {
  if (owner === undefined || info === null) {
    return "the owner is not online";
  }
  if (info.position === null) {
    return `${owner} is out of your view`;
  }
  const looking =
    info.lookingAt === null
      ? "not looking at a block"
      : `looking at ${info.lookingAt.name} at ${formatPosition(info.lookingAt.position)}`;
  return `${owner} is at ${formatPosition(info.position)} facing ${info.facing ?? "?"}, ${looking}`;
}

/** Reads `signal.aborted` afresh; a plain read after an await is wrongly narrowed by the type checker. */
function wasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function emptyTotals(): Totals {
  return { turns: 0, steps: 0, toolCalls: 0, toolErrors: 0, usage: emptyUsage(), costUsd: 0 };
}

function difference(after: Totals, before: Totals): Totals {
  return {
    turns: after.turns - before.turns,
    steps: after.steps - before.steps,
    toolCalls: after.toolCalls - before.toolCalls,
    toolErrors: after.toolErrors - before.toolErrors,
    usage: {
      inputTokens: after.usage.inputTokens - before.usage.inputTokens,
      cachedInputTokens: after.usage.cachedInputTokens - before.usage.cachedInputTokens,
      cacheWriteTokens: after.usage.cacheWriteTokens - before.usage.cacheWriteTokens,
      outputTokens: after.usage.outputTokens - before.usage.outputTokens,
      reasoningTokens: after.usage.reasoningTokens - before.usage.reasoningTokens,
    },
    costUsd: after.costUsd - before.costUsd,
  };
}
