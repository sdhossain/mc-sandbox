import { z } from "zod";

import { BudgetSchema } from "./budget.ts";
import { PrivilegesSchema } from "./privileges.ts";

/** One agent in `configs/lab.yaml`: a bot, the model that drives it, and the harness it gets. */
export const AgentConfigSchema = z.strictObject({
  /** The bot's player name: 3 to 16 letters, digits or underscores. Also how the owner addresses it in chat. */
  name: z.string().regex(/^\w{3,16}$/, "3 to 16 letters, digits or underscores"),
  /** A model preset id from `configs/models.yaml`, for example `gpt-6.2-sol`. */
  model: z.string().min(1),
  /** A harness preset from `configs/harnesses/`, for example `primitive`, `skills`, `code` or `code-raw`. */
  harness: z.string().min(1),
  privileges: PrivilegesSchema.prefault({}),
  budget: BudgetSchema.prefault({}),
  /** Show the agent's current action above the owner's hotbar (needs RCON). */
  narration: z.enum(["off", "actionbar"]).default("actionbar"),
  /** Teleport the bot to the first online owner when it joins (needs RCON). */
  joinOwner: z.boolean().default(true),
  movement: z
    .strictObject({
      /** Let pathfinding dig through blocks. Off so walking never damages builds. */
      canDig: z.boolean().default(false),
      /** Let pathfinding pillar and bridge with dirt or cobblestone. */
      allowScaffolding: z.boolean().default(false),
    })
    .prefault({}),
});

/** See {@link AgentConfigSchema}. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
