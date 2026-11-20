/**
 * Imports every harness module so that each registers itself in {@link HARNESS_REGISTRY}, and the
 * tools they use in the tool registry.
 */

import "../tools/index.ts";
import "./primitive/primitive-harness.ts";
import "./skills/skills-harness.ts";
import "./code/code-harness.ts";

export { HARNESS_REGISTRY, type HarnessEntry } from "./registry.ts";
export { Harness, HarnessConfigSchema, type HarnessConfig, type HarnessContext } from "./harness.ts";
