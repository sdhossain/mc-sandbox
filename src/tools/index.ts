/**
 * Imports every tool module so that each registers its tools in {@link TOOL_REGISTRY}.
 * Import this module (not the registry alone) before building harnesses.
 */

import "./perception/perception-tools.ts";
import "./movement/movement-tools.ts";
import "./building/building-tools.ts";
import "./inventory/inventory-tools.ts";
import "./crafting/crafting-tools.ts";
import "./interaction/interaction-tools.ts";
import "./communication/communication-tools.ts";
import "./skills/skill-tools.ts";

export { TOOL_REGISTRY, createRegisteredTool } from "./registry.ts";
export { Tool, type ToolContext, type ToolResult } from "./tool.ts";
