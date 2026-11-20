import { z } from "zod";

import { requireItemName } from "../../minecraft/names.ts";
import type { ItemCount } from "../../minecraft/types.ts";
import { sleep } from "../../utils/abort.ts";
import { ActionError, TimeoutError } from "../../utils/errors.ts";
import { ToolName } from "../../utils/names.ts";
import { formatItems } from "../common.ts";
import { Tool, type ToolContext, type ToolResult } from "../tool.ts";

/** How long a request waits for the owner's `!approve` or `!deny`. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const RequestItemsArgs = z.strictObject({
  items: z
    .array(
      z.strictObject({
        item: z.string().describe("Item name, for example oak_planks."),
        count: z.int().min(1).max(256).describe("How many."),
      }),
    )
    .min(1)
    .max(12)
    .describe("The items you need."),
  reason: z.string().min(1).max(200).describe("What they are for, in a few words. The owner sees this."),
});

/** How item requests are handled, from the harness preset's `itemRequests` setting. */
export type ItemRequestMode = "automatic" | "approval";

/**
 * Survival mode: asks for items, which the lab then puts in the bot's inventory with `/give`.
 *
 * With `approval`, the owner sees the request in chat and answers `!approve` or `!deny <reason>`;
 * with `automatic`, every request is granted at once. Built by the harness, which knows the mode.
 */
export class RequestItemsTool extends Tool<typeof RequestItemsArgs> {
  readonly name = ToolName.REQUEST_ITEMS;
  readonly description: string;
  readonly parameters = RequestItemsArgs;
  override readonly timeoutMs = APPROVAL_TIMEOUT_MS + 60_000;
  readonly #mode: ItemRequestMode;

  /** @param mode - Whether the owner must approve each request. */
  constructor(mode: ItemRequestMode) {
    super();
    this.#mode = mode;
    this.description =
      mode === "approval"
        ? "Ask the owner for items, saying what they are for. The owner approves or denies in chat (you wait up to 5 minutes); approved items go straight into your inventory. If denied, gather or craft them instead."
        : "Get items you need: they are put straight into your inventory. Say what they are for.";
  }

  /** Asks (when approval is required), then gives the items. */
  async execute(args: z.infer<typeof RequestItemsArgs>, context: ToolContext): Promise<ToolResult> {
    const items = mergeItems(
      args.items.map((entry) => ({ name: requireItemName(context.game.mcData, entry.item), count: entry.count })),
    );
    if (!context.server.available) {
      throw new ActionError("Items cannot be given: the lab has no RCON connection to the server.");
    }
    const list = formatItems(items);
    let approvedBy: string | null = null;
    if (this.#mode === "approval") {
      context.progress(`waiting for approval: ${list}`);
      let decision;
      try {
        decision = await context.approvals.ask(
          `${context.agentName} asks for ${list} (${args.reason}). Reply !approve, or !deny with a reason.`,
          { signal: context.signal, timeoutMs: APPROVAL_TIMEOUT_MS },
        );
      } catch (error) {
        if (error instanceof TimeoutError) {
          return {
            output: `No answer from the owner within ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so nothing was given. Ask again later, or gather the items yourself.`,
            isError: true,
            data: { items, reason: args.reason, decision: "no answer" },
          };
        }
        throw error;
      }
      if (!decision.approved) {
        const because = decision.note === "" ? "" : `: ${decision.note}`;
        return {
          output: `${decision.by} denied the request${because}. Nothing was given; gather or craft the items yourself, or change the plan.`,
          isError: true,
          data: { items, reason: args.reason, decision: "denied", by: decision.by, note: decision.note },
        };
      }
      approvedBy = decision.by;
    }

    const before = new Map(items.map((item) => [item.name, context.game.inventory.count(item.name)]));
    const replies: string[] = [];
    for (const item of items) {
      replies.push(await context.server.run(`give ${context.agentName} ${item.name} ${item.count}`));
    }
    await sleep(500, context.signal);
    const received = items.map((item) => ({
      name: item.name,
      count: context.game.inventory.count(item.name) - (before.get(item.name) ?? 0),
    }));
    const short = received.filter((item, index) => item.count < (items[index]?.count ?? 0));
    const note =
      short.length === 0
        ? ""
        : ` Some did not fit in the inventory and were dropped at your feet: ${formatItems(short)} short.`;
    const prefix = approvedBy === null ? "" : `${approvedBy} approved. `;
    return {
      output: `${prefix}Received ${formatItems(received.filter((item) => item.count > 0))}.${note}`,
      data: {
        items,
        reason: args.reason,
        decision: approvedBy === null ? "granted" : "approved",
        by: approvedBy,
        received,
        replies,
      },
    };
  }
}

/** Sums repeated items. */
function mergeItems(items: readonly ItemCount[]): ItemCount[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return [...totals.entries()].map(([name, count]) => ({ name, count }));
}
