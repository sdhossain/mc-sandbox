/**
 * Provider-neutral types for talking to a language model.
 *
 * The agent keeps its conversation as a list of {@link ConversationItem}s. Each provider adapter maps
 * these to its own wire format. Items a provider produced carry the provider's original item in
 * `native`, so the same provider receives it back byte for byte. OpenAI needs this for reasoning and
 * compaction items, and it keeps the prompt-cache prefix stable.
 */

import type { ProviderName } from "../utils/names.ts";

/** A JSON Schema object, as sent to the provider for tool parameters. */
export type JsonSchema = Record<string, unknown>;

/** A provider's own representation of an item, kept so it can be replayed to that provider unchanged. */
export interface NativeItem {
  /** The provider that produced the item. Other providers ignore it and use the neutral fields. */
  readonly provider: ProviderName;
  /** The item exactly as the provider returned it. */
  readonly value: unknown;
}

/** A message from the owner, or a notice from the lab, delivered to the model as a user turn. */
export interface UserMessageItem {
  readonly kind: "user";
  readonly text: string;
}

/** Visible text the model wrote. */
export interface AssistantMessageItem {
  readonly kind: "assistant";
  readonly text: string;
  readonly native?: NativeItem;
}

/** A tool call the model requested. */
export interface ToolCallItem {
  readonly kind: "tool_call";
  /** Provider-assigned id that the matching {@link ToolOutputItem} must echo. */
  readonly callId: string;
  readonly name: string;
  /** The arguments as the raw JSON text the model produced. Parsed and validated by the tool executor. */
  readonly arguments: string;
  readonly native?: NativeItem;
}

/** The result of one tool call, sent back to the model. */
export interface ToolOutputItem {
  readonly kind: "tool_output";
  readonly callId: string;
  /** Text for the model. Already truncated to the harness's output limit. */
  readonly output: string;
  readonly isError: boolean;
}

/** The model's reasoning. Only the summary is readable; the provider may also return an encrypted form. */
export interface ReasoningItem {
  readonly kind: "reasoning";
  /** Readable reasoning summary, empty when the provider gives none. */
  readonly summary: string;
  readonly native?: NativeItem;
}

/** A provider-side compaction of earlier context. Opaque; only replayed to the provider that made it. */
export interface CompactionItem {
  readonly kind: "compaction";
  readonly native: NativeItem;
}

/** One entry of the conversation. The conversation is append-only. */
export type ConversationItem =
  UserMessageItem | AssistantMessageItem | ToolCallItem | ToolOutputItem | ReasoningItem | CompactionItem;

/** A tool as described to the model. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. Strict-mode compatible: every property required, optional ones nullable. */
  readonly parameters: JsonSchema;
}

/** One request to the model. */
export interface ModelRequest {
  /** The system prompt. Adapters send it as the first, stable part of the prompt. */
  readonly instructions: string;
  /** The whole conversation so far, oldest first. */
  readonly items: readonly ConversationItem[];
  /** Tools the model may call. Keep the list and its order fixed within a run so the prompt cache holds. */
  readonly tools: readonly ToolSpec[];
  /** Aborts the request when the owner stops the agent. */
  readonly signal?: AbortSignal;
  /** Stable id for the run, which some providers use to route requests to the same prompt cache. */
  readonly cacheKey?: string;
}

/** Token counts for one model call. */
export interface TokenUsage {
  /** All input tokens, including cached ones. */
  readonly inputTokens: number;
  /** Input tokens read from the provider's prompt cache. */
  readonly cachedInputTokens: number;
  /** Input tokens written to the prompt cache, where the provider bills them separately. */
  readonly cacheWriteTokens: number;
  /** All output tokens, including reasoning tokens. */
  readonly outputTokens: number;
  /** Output tokens spent on hidden reasoning. */
  readonly reasoningTokens: number;
}

/** Why the model stopped generating. */
export const StopReason = {
  /** The model requested one or more tool calls. */
  TOOL_CALLS: "tool_calls",
  /** The model finished its answer. */
  END_TURN: "end_turn",
  /** The output token limit was reached. */
  MAX_TOKENS: "max_tokens",
  /** The provider filtered or refused the output. */
  CONTENT_FILTER: "content_filter",
  /** Anything else the provider reported. */
  OTHER: "other",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** The model's answer to one {@link ModelRequest}. */
export interface ModelResponse {
  /** New items to append to the conversation, in the order the provider produced them. */
  readonly items: readonly ConversationItem[];
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
  /** Cost of this call in US dollars, from the model's configured prices. */
  readonly costUsd: number;
  /** Wall-clock time of the call, including retries. */
  readonly latencyMs: number;
  /** The model name the provider reports having used, which can differ from the requested alias. */
  readonly servedModel: string;
  /** Provider request id, for support tickets and debugging. */
  readonly requestId?: string;
  /** Provider-specific details worth logging, for example OpenAI's `input_transformations`. */
  readonly diagnostics?: Record<string, unknown>;
}

/** Returns a usage record with every count set to zero. */
export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

/** Adds two usage records. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}
