import type { ToolName } from "../utils/names.ts";
import { Registry } from "../utils/registry.ts";
import type { Tool } from "./tool.ts";

/** A tool class with a no-argument constructor. */
export type ToolClass = new () => Tool;

/**
 * All tools that can be built without arguments, by name. Each tool module registers its classes on
 * import; `tools/index.ts` imports them all. Harness presets refer to tools by these names.
 */
export const TOOL_REGISTRY = new Registry<ToolName, ToolClass>("tool");

/** Builds the tool registered under `name`. */
export function createRegisteredTool(name: ToolName): Tool {
  const ToolClass = TOOL_REGISTRY.get(name);
  return new ToolClass();
}
