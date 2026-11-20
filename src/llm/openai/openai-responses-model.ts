import OpenAI from "openai";
import { toResponseInputItem } from "openai/lib/responses/ResponseInputItems";
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

import { AbortedError, describeCauses, ModelError } from "../../utils/errors.ts";
import { ProviderName } from "../../utils/names.ts";
import { LanguageModel, ModelConfigSchema, type ProviderResult } from "../language-model.ts";
import { PROVIDER_REGISTRY } from "../registry.ts";
import { StopReason, type ConversationItem, type ModelRequest, type NativeItem, type TokenUsage } from "../types.ts";

/** Config of an OpenAI Responses API model. */
export const OpenAIResponsesConfigSchema = ModelConfigSchema.extend({
  provider: z.literal(ProviderName.OPENAI),
  /** Reasoning effort; omit for the model's default. Not every model accepts every value. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /** Request readable reasoning summaries, shown on the dashboard. */
  reasoningSummary: z.enum(["auto", "concise", "detailed"]).nullable().default("auto"),
  /** Output verbosity; omit for the model's default. */
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  /** Let the model request several tool calls in one response. They still run one after another. */
  parallelToolCalls: z.boolean().default(true),
  /** Send tools with `strict: true`, so arguments always match the schema. */
  strictTools: z.boolean().default(true),
  /** Ask the server to compact the context when the prompt passes this many tokens. Null disables it. */
  compactThreshold: z.int().positive().nullable().default(200_000),
  /** API base URL; omit for api.openai.com. */
  baseUrl: z.url().optional(),
  /** Environment variable holding the API key. */
  apiKeyEnv: z.string().default("OPENAI_API_KEY"),
});

/** See {@link OpenAIResponsesConfigSchema}. */
export type OpenAIResponsesConfig = z.infer<typeof OpenAIResponsesConfigSchema>;

/**
 * {@link LanguageModel} for OpenAI's Responses API, used statelessly.
 *
 * Every request carries the whole conversation (`store: false`), so the run's trace holds everything
 * the model saw. Output items are replayed verbatim on later requests through their `native` copy,
 * which OpenAI requires for reasoning and compaction items and which keeps the prompt-cache prefix
 * stable. The system prompt is sent as the first developer message, which is cached with the prefix.
 *
 * The client has its own HTTP connection pool. When requests keep failing to connect even after the
 * SDK's retries, the pool is replaced and the request is tried once more, so a connection left broken
 * by a network change cannot make every later call fail until the lab is restarted.
 */
export class OpenAIResponsesModel extends LanguageModel<OpenAIResponsesConfig> {
  readonly #client: OpenAI;
  #connections: Agent = newConnectionPool();

  /** @param config - Validated config; the API key is read from `config.apiKeyEnv`. */
  constructor(config: OpenAIResponsesConfig) {
    super(config);
    const apiKey = process.env[config.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
      throw new ModelError(`${config.apiKeyEnv} is not set. Put it in .env (see .env.example).`, false);
    }
    // undici's fetch is typed against undici's own Request and Response classes, which match the
    // global ones at runtime but not in the type checker.
    const fetchThroughPool = ((input: string | URL, init?: RequestInit) =>
      undiciFetch(input, { ...(init as object), dispatcher: this.#connections })) as unknown as typeof fetch;
    this.#client = new OpenAI({
      apiKey,
      maxRetries: config.maxRetries,
      timeout: config.timeoutMs,
      fetch: fetchThroughPool,
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });
  }

  /** Closes the connection pool. */
  override async close(): Promise<void> {
    await this.#connections.close();
  }

  protected async call(request: ModelRequest): Promise<ProviderResult> {
    try {
      return await this.#send(request);
    } catch (error) {
      if (!isConnectionFailure(error) || request.signal?.aborted === true) {
        throw toModelError(error);
      }
      // The SDK has already retried on this pool; start a fresh one and try once more.
      this.#replaceConnectionPool();
      try {
        return await this.#send(request);
      } catch (retryError) {
        throw toModelError(retryError);
      }
    }
  }

  #replaceConnectionPool(): void {
    const old = this.#connections;
    this.#connections = newConnectionPool();
    void old.destroy().catch(() => undefined);
  }

  /** One request through the SDK, with its own retries. Throws the SDK's errors unchanged. */
  async #send(request: ModelRequest): Promise<ProviderResult> {
    const config = this.config;
    const tools: FunctionTool[] = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: config.strictTools,
    }));
    const result = await this.#client.responses
      .create(
        {
          model: config.model,
          input: this.#toInput(request),
          tools,
          tool_choice: "auto",
          parallel_tool_calls: config.parallelToolCalls,
          store: false,
          max_output_tokens: config.maxOutputTokens,
          ...(config.reasoningEffort === undefined && config.reasoningSummary === null
            ? {}
            : {
                reasoning: {
                  ...(config.reasoningEffort === undefined ? {} : { effort: config.reasoningEffort }),
                  ...(config.reasoningSummary === null ? {} : { summary: config.reasoningSummary }),
                },
              }),
          ...(config.verbosity === undefined ? {} : { text: { verbosity: config.verbosity } }),
          ...(config.compactThreshold === null
            ? {}
            : { context_management: [{ type: "compaction", compact_threshold: config.compactThreshold }] }),
          ...(request.cacheKey === undefined ? {} : { prompt_cache_key: request.cacheKey }),
        },
        request.signal === undefined ? {} : { signal: request.signal },
      )
      .withResponse();
    return this.#fromResponse(result.data, result.request_id);
  }

  /** The developer message, then the conversation from the latest compaction onwards. */
  #toInput(request: ModelRequest): ResponseInputItem[] {
    const input: ResponseInputItem[] = [{ role: "developer", content: request.instructions }];
    let start = 0;
    request.items.forEach((item, index) => {
      if (item.kind === "compaction" && item.native.provider === ProviderName.OPENAI) {
        start = index;
      }
    });
    for (const item of request.items.slice(start)) {
      const mapped = this.#toInputItem(item);
      if (mapped !== null) {
        input.push(mapped);
      }
    }
    return input;
  }

  #toInputItem(item: ConversationItem): ResponseInputItem | null {
    if ("native" in item && item.native?.provider === ProviderName.OPENAI) {
      return item.native.value as ResponseInputItem;
    }
    switch (item.kind) {
      case "user":
        return { role: "user", content: item.text };
      case "assistant":
        return { role: "assistant", content: item.text };
      case "tool_call":
        return { type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments };
      case "tool_output":
        return { type: "function_call_output", call_id: item.callId, output: item.output };
      case "reasoning":
      case "compaction":
        // Another provider's reasoning cannot be replayed to OpenAI.
        return null;
    }
  }

  #fromResponse(response: Response, requestId: string | null): ProviderResult {
    const items: ConversationItem[] = [];
    for (const output of response.output) {
      const item = toConversationItem(output);
      if (item !== null) {
        items.push(item);
      }
    }
    const hasToolCalls = items.some((item) => item.kind === "tool_call");
    const diagnostics: Record<string, unknown> = { status: response.status };
    if (response.incomplete_details !== null) {
      diagnostics.incomplete = response.incomplete_details;
    }
    const transformations = (response as unknown as { input_transformations?: unknown }).input_transformations;
    if (transformations !== undefined && transformations !== null) {
      diagnostics.inputTransformations = transformations;
    }
    return {
      items,
      usage: toUsage(response.usage),
      stopReason: hasToolCalls ? StopReason.TOOL_CALLS : stopReasonOf(response),
      servedModel: response.model,
      ...(requestId === null ? {} : { requestId }),
      diagnostics,
    };
  }
}

/** Maps one output item to a conversation item, keeping the replayable original. */
function toConversationItem(output: ResponseOutputItem): ConversationItem | null {
  const replayable = toResponseInputItem(output);
  const native: NativeItem | undefined =
    replayable === null ? undefined : { provider: ProviderName.OPENAI, value: replayable };
  switch (output.type) {
    case "message": {
      const text = output.content
        .map((part) => (part.type === "output_text" ? part.text : `[refusal] ${part.refusal}`))
        .join("");
      return { kind: "assistant", text, ...(native === undefined ? {} : { native }) };
    }
    case "function_call":
      return {
        kind: "tool_call",
        callId: output.call_id,
        name: output.name,
        arguments: output.arguments,
        ...(native === undefined ? {} : { native }),
      };
    case "reasoning":
      return {
        kind: "reasoning",
        summary: output.summary.map((part) => part.text).join("\n\n"),
        ...(native === undefined ? {} : { native }),
      };
    case "compaction":
      return native === undefined ? null : { kind: "compaction", native };
    default:
      return null;
  }
}

function stopReasonOf(response: Response): StopReason {
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") {
      return StopReason.MAX_TOKENS;
    }
    if (reason === "content_filter") {
      return StopReason.CONTENT_FILTER;
    }
    return StopReason.OTHER;
  }
  return response.status === "completed" ? StopReason.END_TURN : StopReason.OTHER;
}

function toUsage(usage: Response["usage"]): TokenUsage {
  if (usage === undefined) {
    return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  }
  const details = usage.input_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  };
}

/** Converts an SDK error into the lab's error types. */
export function toModelError(error: unknown): Error {
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AbortedError("Model call aborted");
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ModelError(
      `Could not reach the OpenAI API (${describeCauses(error)}). Check the internet connection; the lab retries on the next message.`,
      true,
      { cause: error },
    );
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status as number | undefined;
    const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    return new ModelError(`OpenAI API error${status === undefined ? "" : ` ${status}`}: ${error.message}`, retryable, {
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new ModelError(`Model call failed: ${error.message}`, true, { cause: error });
  }
  return new ModelError(`Model call failed: ${String(error)}`, true);
}

/** True for errors where no HTTP response arrived (as opposed to an error status from the API). */
function isConnectionFailure(error: unknown): boolean {
  return error instanceof OpenAI.APIConnectionError && !(error instanceof OpenAI.APIUserAbortError);
}

/** A fresh HTTP connection pool for the API. */
function newConnectionPool(): Agent {
  return new Agent({ connect: { timeout: 20_000 }, keepAliveTimeout: 15_000 });
}

PROVIDER_REGISTRY.register(ProviderName.OPENAI, {
  configSchema: OpenAIResponsesConfigSchema,
  create: (config) => new OpenAIResponsesModel(OpenAIResponsesConfigSchema.parse(config)),
});
