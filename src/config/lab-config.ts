import { z } from "zod";

import { AgentConfigSchema } from "../agent/agent-config.ts";

/** The vanilla server version the lab targets. Mineflayer 4.39 supports it. */
export const MINECRAFT_VERSION = "1.21.11";

/** Environment variable whose names (separated by commas) replace `owners` in the lab file, so they can live in `.env`. */
export const OWNERS_VARIABLE = "MCLAB_OWNERS";

/** `configs/lab.yaml`: which server to join, who the owners are, which agents to start. */
export const LabConfigSchema = z.strictObject({
  server: z
    .strictObject({
      host: z.string().default("127.0.0.1"),
      port: z.int().positive().default(25565),
      version: z.string().default(MINECRAFT_VERSION),
      /** The local server folder made by `npm run server:setup`. RCON settings are read from its server.properties. */
      directory: z.string().default("server"),
      rcon: z
        .strictObject({
          /** Use RCON for game modes, teleports, the action-bar status line and `run_command`. */
          enabled: z.boolean().default(true),
          host: z.string().optional(),
          /** Defaults to `rcon.port` in server.properties. */
          port: z.int().positive().optional(),
          /** Defaults to `rcon.password` in server.properties. */
          password: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Players allowed to command the agents. Use your exact Minecraft name. */
  owners: z
    .array(z.string().regex(/^\w{3,16}$/))
    .min(1, `add your exact Minecraft name, here or in .env as ${OWNERS_VARIABLE}=<name>`),
  /** Where run directories are written. */
  runsDir: z.string().default("runs"),
  /** Complete copies of the server's world, saved while the lab runs. They need RCON. */
  checkpoints: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Where checkpoints are kept. */
      dir: z.string().default("checkpoints"),
      /** Minutes between automatic checkpoints; 0 turns the timer off. */
      everyMinutes: z.number().nonnegative().default(10),
      /** Save one as soon as the lab has started. */
      atStart: z.boolean().default(true),
    })
    .prefault({}),
  dashboard: z
    .strictObject({
      enabled: z.boolean().default(true),
      host: z.string().default("127.0.0.1"),
      port: z.int().positive().default(8787),
    })
    .prefault({}),
  agents: z.array(AgentConfigSchema).min(1),
});

/** See {@link LabConfigSchema}. */
export type LabConfig = z.infer<typeof LabConfigSchema>;
