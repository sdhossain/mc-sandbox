import type { z } from "zod";

import type { ProviderName } from "../utils/names.ts";
import { Registry } from "../utils/registry.ts";
import type { LanguageModel, ModelConfig } from "./language-model.ts";

/** A registered provider adapter: its config schema and how to build it. */
export interface ProviderEntry {
  /** Validates a model preset for this provider. */
  readonly configSchema: z.ZodType<ModelConfig>;
  /** Builds the adapter from a validated config. */
  create(config: ModelConfig): LanguageModel;
}

/**
 * All provider adapters, by name. Each adapter module registers itself on import; `llm/index.ts`
 * imports them all.
 */
export const PROVIDER_REGISTRY = new Registry<ProviderName, ProviderEntry>("model provider");
