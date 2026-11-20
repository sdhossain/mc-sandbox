import type { z } from "zod";

import type { HarnessName } from "../utils/names.ts";
import { Registry } from "../utils/registry.ts";
import type { Harness, HarnessConfig, HarnessContext } from "./harness.ts";

/** A registered harness: its config schema and how to build it. */
export interface HarnessEntry {
  /** Validates a preset file for this harness. */
  readonly configSchema: z.ZodType<HarnessConfig>;
  /** Builds the harness from a validated config. */
  create(config: HarnessConfig, context: HarnessContext): Harness;
}

/**
 * All harness classes, by name. Each harness module registers itself on import; `harness/index.ts`
 * imports them all.
 */
export const HARNESS_REGISTRY = new Registry<HarnessName, HarnessEntry>("harness");
