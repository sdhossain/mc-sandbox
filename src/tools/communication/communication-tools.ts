/** Tools for talking and waiting. */

import { z } from "zod";

import { sleep } from "../../utils/abort.ts";
import { ToolName } from "../../utils/names.ts";
import { TOOL_REGISTRY } from "../registry.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

const ChatArgs = z.strictObject({
  message: z.string().min(1).max(1_000).describe("What to say in public chat."),
});

/** Says something in chat now, before the turn ends. */
export class ChatTool extends Tool<typeof ChatArgs> {
  readonly name = ToolName.CHAT;
  readonly description =
    "Say something in public chat now, for example a progress update or a question to the owner. Your final reply is sent automatically; do not repeat it here.";
  readonly parameters = ChatArgs;

  /** Says the message. */
  async execute(args: z.infer<typeof ChatArgs>, context: ToolContext): Promise<ToolResult> {
    await context.game.chat.say(args.message);
    return { output: "Sent.", data: { message: args.message } };
  }
}

const WaitArgs = z.strictObject({
  seconds: z.number().min(0.1).max(60).describe("How long to wait, up to 60 seconds."),
});

/** Waits, for example for crops to grow or a furnace to finish. */
export class WaitTool extends Tool<typeof WaitArgs> {
  readonly name = ToolName.WAIT;
  readonly description = "Wait for a number of seconds, for example for water to flow or an item to drop.";
  readonly parameters = WaitArgs;

  /** Waits. */
  async execute(args: z.infer<typeof WaitArgs>, context: ToolContext): Promise<ToolResult> {
    await sleep(args.seconds * 1000, context.signal);
    return { output: `Waited ${args.seconds} s.` };
  }
}

TOOL_REGISTRY.register(ToolName.CHAT, ChatTool);
TOOL_REGISTRY.register(ToolName.WAIT, WaitTool);
