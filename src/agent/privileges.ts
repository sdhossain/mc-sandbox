import { z } from "zod";

import { GameMode } from "../utils/names.ts";

/**
 * What an agent is allowed to do in the world, independent of its harness.
 *
 * The same harness can be run in survival (gather and craft everything) or creative (unlimited blocks),
 * so "can it build" and "can it survive" are measured separately. Server commands are part of the
 * harness's action space instead (`commands` in a harness preset).
 */
export const PrivilegesSchema = z.strictObject({
  /** Game mode the lab puts the bot in when it joins. */
  gameMode: z.enum([GameMode.SURVIVAL, GameMode.CREATIVE]).default(GameMode.SURVIVAL),
});

/** See {@link PrivilegesSchema}. */
export type Privileges = z.infer<typeof PrivilegesSchema>;
