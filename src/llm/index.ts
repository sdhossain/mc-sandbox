/** Imports every provider adapter so that each registers itself in {@link PROVIDER_REGISTRY}. */

import "./openai/openai-responses-model.ts";
import "./scripted/scripted-model.ts";

export { PROVIDER_REGISTRY, type ProviderEntry } from "./registry.ts";
export { LanguageModel, ModelConfigSchema, type ModelConfig } from "./language-model.ts";
