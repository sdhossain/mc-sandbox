import { loadLabConfig } from "../../config/load-config.ts";
import { connectServerControl, worldDirectoryOf } from "../../lab/lab.ts";
import { savesDirectory } from "../../mcserver/minecraft-saves.ts";
import { WorldCheckpointer } from "../../mcserver/world-checkpointer.ts";
import { NullServerControl } from "../../minecraft/server-control/server-control.ts";
import { LabError } from "../../utils/errors.ts";
import { formatBytes, formatDuration } from "../../utils/text.ts";
import { Command, stringFlag, type Flags } from "../command.ts";

/** `mclab checkpoint`: saves, lists and opens world checkpoints. */
export class CheckpointCommand extends Command {
  readonly name = "checkpoint";
  readonly summary = "Save, list or open copies of the server's world";
  readonly usage = `Usage: mclab checkpoint <save [label] | list | open <id>> [flags]

  save [label]   Save a copy of the world now (the server must be running; needs RCON)
  list           List saved checkpoints
  open <id>      Copy a checkpoint into your Minecraft saves folder, to open in Singleplayer

Flags:
  --config <path>   Lab config (default configs/lab.yaml)
  --saves <dir>     Saves folder for "open" (default: the most recently used launcher profile's)`;
  protected readonly options = {
    config: { type: "string" },
    saves: { type: "string" },
  } as const;

  protected async execute(flags: Flags, positionals: readonly string[]): Promise<number> {
    const config = loadLabConfig(stringFlag(flags, "config"));
    const [action, ...rest] = positionals;
    if (action === "list") {
      return this.#list(
        new WorldCheckpointer(new NullServerControl(), worldDirectoryOf(config), config.checkpoints.dir),
      );
    }
    if (action === "open") {
      const [id] = rest;
      if (id === undefined) {
        throw new LabError("Which checkpoint? Usage: mclab checkpoint open <id> (see: mclab checkpoint list)");
      }
      const checkpoints = new WorldCheckpointer(
        new NullServerControl(),
        worldDirectoryOf(config),
        config.checkpoints.dir,
      );
      const folder = checkpoints.openCopy(id, stringFlag(flags, "saves") ?? savesDirectory());
      console.log(`Copied to ${folder}\nIn Minecraft: Singleplayer, then pick "${folder.split("/").at(-1) ?? id}".`);
      return 0;
    }
    if (action === "save") {
      const server = await connectServerControl(config);
      try {
        const checkpoints = new WorldCheckpointer(server, worldDirectoryOf(config), config.checkpoints.dir);
        const info = await checkpoints.save(rest.join(" ") || "manual");
        console.log(
          `Saved ${info.worldPath}: ${info.fileCount} files, ${formatBytes(info.copiedBytes)} new, ${formatBytes(info.linkedBytes)} shared with the previous checkpoint, in ${formatDuration(info.durationMs)}.`,
        );
      } finally {
        await server.close();
      }
      return 0;
    }
    console.log(this.usage);
    return action === undefined ? 0 : 1;
  }

  #list(checkpoints: WorldCheckpointer): Promise<number> {
    const list = checkpoints.list();
    if (list.length === 0) {
      console.log(`No checkpoints in ${checkpoints.storeDir} yet.`);
    }
    for (const info of list) {
      const tick = info.gameTime === null ? "" : `  game tick ${info.gameTime}`;
      console.log(`${info.id.padEnd(44)} ${formatBytes(info.copiedBytes).padStart(9)} new${tick}`);
    }
    return Promise.resolve(0);
  }
}
