import { z } from "zod";

import { ProviderName } from "../utils/names.ts";
import type { ModelRequest, ModelResponse, StopReason, TokenUsage } from "./types.ts";

/** Prices in US dollars per million tokens, used to report the cost of every call. */
export const ModelPricingSchema = z.strictObject({
  inputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative(),
  /** Price of writing input to the prompt cache, where billed separately. Defaults to the input price. */
  cacheWritePerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative(),
});

/** Fields every model config has. Model presets live in `configs/models.yaml`. */
export const ModelConfigSchema = z.strictObject({
  /** Preset name used on the command line and in run names, for example `gpt-6.2-sol`. */
  id: z.string().min(1),
  provider: z.enum(Object.values(ProviderName) as [ProviderName, ...ProviderName[]]),
  /** The model name sent to the provider. */
  model: z.string().min(1),
  pricing: ModelPricingSchema,
  /** Output token limit per call, including reasoning tokens. */
  maxOutputTokens: z.int().positive().default(32_000),
  /** Time limit per call attempt. */
  timeoutMs: z.int().positive().default(240_000),
  /** Retries on rate limits, timeouts, server errors and dropped connections (backoff grows to 8 s). */
  maxRetries: z.int().nonnegative().default(5),
  /** One line shown in `mclab models`. */
  description: z.string().default(""),
});

/** See {@link ModelConfigSchema}. */
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** What a provider adapter returns from one call; {@link LanguageModel.generate} adds timing and cost. */
export interface ProviderResult {
  readonly items: ModelResponse["items"];
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
  readonly servedModel: string;
  readonly requestId?: string;
  readonly diagnostics?: Record<string, unknown>;
}

/**
 * Base class for a model provider adapter.
 *
 * Subclasses translate the neutral {@link ModelRequest} into their provider's API and back in
 * {@link call}. The template method {@link generate} adds timing and cost, so every provider reports
 * them the same way.
 *
 * @typeParam C - The provider's config type.
 */
export abstract class LanguageModel<C extends ModelConfig = ModelConfig> {
  readonly config: C;

  /** @param config - Validated model config. */
  constructor(config: C) {
    this.config = config;
  }

  /** The preset name, for example `gpt-6.2-sol`. */
  get id(): string {
    return this.config.id;
  }

  /**
   * Sends one request and returns the model's answer with usage, cost and latency. Not meant to be overridden.
   *
   * @throws ModelError when the provider fails after retries.
   * @throws AbortedError when `request.signal` aborts.
   */
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const result = await this.call(request);
    return {
      ...result,
      costUsd: this.costOf(result.usage),
      latencyMs: Math.round(performance.now() - started),
    };
  }

  /** The cost of `usage` in US dollars at this model's configured prices. */
  costOf(usage: TokenUsage): number {
    const { inputPerMTok, cachedInputPerMTok, cacheWritePerMTok = inputPerMTok, outputPerMTok } = this.config.pricing;
    const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
    const dollars =
      uncachedInput * inputPerMTok +
      usage.cachedInputTokens * cachedInputPerMTok +
      usage.cacheWriteTokens * cacheWritePerMTok +
      usage.outputTokens * outputPerMTok;
    return dollars / 1_000_000;
  }

  /** Releases network resources. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Calls the provider once (with the provider's own retries) and maps the answer to neutral items. */
  protected abstract call(request: ModelRequest): Promise<ProviderResult>;
}
