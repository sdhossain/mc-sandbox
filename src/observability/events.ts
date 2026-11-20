/**
 * The event schema: everything the lab records about a run.
 *
 * Every event is one line of `events.jsonl` in the run directory and one message on the dashboard's
 * live stream. Events are append-only facts; a run can be reconstructed from its events alone.
 */

import type { CaseResult } from "../cases/case-checks.ts";
import type { ConversationItem, StopReason, TokenUsage, ToolSpec } from "../llm/types.ts";
import type { BlockChange, BlockPosition, BotStatus } from "../minecraft/types.ts";
import type { MessageSource, RunStatus, TurnStatus } from "../utils/names.ts";

/** Running totals for a turn or a run. */
export interface Totals {
  readonly turns: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

/** A conversation item as logged: provider-native payloads (encrypted reasoning) are left out. */
export type LoggedItem = DistributiveOmit<ConversationItem, "native">;

/** `Omit` applied to each member of a union separately. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The event payloads, keyed by event type. */
export interface EventPayloads {
  /** A run began: the agent's full setup, so the run can be understood without the config files. */
  "run.started": {
    readonly harness: string;
    readonly harnessConfig: unknown;
    readonly model: string;
    readonly modelConfig: unknown;
    readonly privileges: unknown;
    readonly instructions: string;
    readonly tools: readonly ToolSpec[];
  };
  "run.ended": { readonly status: RunStatus; readonly totals: Totals };

  /** An owner message started a turn. `text` is the message as delivered to the model, status line included. */
  "turn.started": {
    readonly source: MessageSource;
    readonly from: string;
    readonly message: string;
    readonly delivered: string;
  };
  "turn.ended": {
    readonly status: TurnStatus;
    readonly reason: string;
    readonly finalText: string;
    readonly durationMs: number;
    readonly totals: Totals;
  };

  /** An owner message arrived while the agent was busy; it is delivered at the next step boundary. */
  "message.queued": { readonly source: MessageSource; readonly from: string; readonly message: string };
  /** A queued message was handed to the model mid-turn. */
  "message.delivered": { readonly from: string; readonly message: string };
  /** An owner control command (`!stop`, `!reset`, `!status`, ...). */
  "control.command": { readonly source: MessageSource; readonly from: string; readonly command: string };

  /** A model call is about to be made. `newItems` are the items appended since the previous call. */
  "model.request": { readonly itemCount: number; readonly newItems: readonly LoggedItem[] };
  "model.response": {
    readonly items: readonly LoggedItem[];
    readonly usage: TokenUsage;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly stopReason: StopReason;
    readonly servedModel: string;
    readonly requestId?: string;
    readonly diagnostics?: Record<string, unknown>;
  };
  "model.error": { readonly message: string; readonly retryable: boolean };

  "tool.started": { readonly callId: string; readonly name: string; readonly arguments: unknown };
  "tool.progress": { readonly callId: string; readonly name: string; readonly message: string };
  "tool.finished": {
    readonly callId: string;
    readonly name: string;
    readonly ok: boolean;
    readonly output: string;
    readonly durationMs: number;
    readonly data?: Readonly<Record<string, unknown>>;
  };

  "chat.received": {
    readonly from: string;
    readonly text: string;
    readonly whisper: boolean;
    readonly addressedToMe: boolean;
  };
  "chat.sent": { readonly text: string; readonly to?: string };

  /** Periodic bot condition, for the dashboard's status panel. */
  "bot.status": BotStatus;
  /** Connection and life events. */
  "bot.lifecycle": {
    readonly kind: "connecting" | "spawned" | "died" | "respawned" | "kicked" | "disconnected" | "reconnecting";
    readonly detail: string;
  };

  /** Block changes seen since the previous batch. */
  "world.changes": { readonly changes: readonly BlockChange[] };
  /** A region snapshot was written to the run directory. */
  "snapshot.saved": { readonly file: string; readonly phase: "before" | "after"; readonly blocks: number };

  "budget.exceeded": { readonly budget: string; readonly limit: number; readonly value: number };

  /** A copy of the whole world was saved (see `checkpoints/<id>`). */
  "checkpoint.saved": {
    readonly id: string;
    readonly label: string;
    readonly worldPath: string;
    readonly gameTime: number | null;
    readonly copiedBytes: number;
    readonly linkedBytes: number;
    readonly durationMs: number;
  };
  /** A failure case built its scene and sent its task. */
  "case.started": {
    readonly id: string;
    readonly title: string;
    readonly category: string;
    readonly anchor: BlockPosition;
    readonly prompt: string;
  };
  /** A failure case's checks, evaluated at the end of a turn. */
  "case.result": CaseResult;
  /** Free-form diagnostics. */
  log: { readonly level: "debug" | "info" | "warn" | "error"; readonly message: string; readonly detail?: unknown };
}

/** An event type name. */
export type EventType = keyof EventPayloads;

/** Fields every event carries. */
export interface EventEnvelope<T extends EventType = EventType> {
  /** Order within the lab process, increasing from 1 across all agents. */
  readonly seq: number;
  /** ISO 8601 time. */
  readonly ts: string;
  readonly type: T;
  readonly agent: string;
  readonly runId: string;
  /** Turn number within the run, from 1; absent outside a turn. */
  readonly turn?: number;
  /** Step number within the turn, from 1; absent outside a step. */
  readonly step?: number;
}

/** One recorded event. */
export type LabEvent = { [T in EventType]: EventEnvelope<T> & { readonly data: EventPayloads[T] } }[EventType];

/** Removes provider-native payloads from conversation items for logging. */
export function toLoggedItems(items: readonly ConversationItem[]): LoggedItem[] {
  return items.map((item) => {
    if (!("native" in item)) {
      return item;
    }
    const { native: _native, ...rest } = item;
    return rest;
  });
}
