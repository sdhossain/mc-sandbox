import { copyFileSync, cpSync, existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { LabError } from "../utils/errors.ts";
import { offlineUuid } from "./offline-uuid.ts";

/** What {@link WorldImporter.import} did. */
export interface WorldImportReport {
  readonly source: string;
  readonly destination: string;
  /** Where an existing server world was moved, if there was one. */
  readonly backup: string | null;
  /** Player data copied to the owner's offline UUID, if any. */
  readonly playerData: { readonly from: string; readonly to: string } | null;
}

/**
 * Copies a singleplayer save into the server folder as its world. The original save is never modified.
 *
 * A dedicated server keys player data by UUID, and offline mode gives the owner a different UUID than
 * their Microsoft account has. So when the save has exactly one player's data, the importer copies it
 * (inventory, position, stats, advancements) to the owner's offline UUID, and the owner keeps their
 * inventory and position.
 */
export class WorldImporter {
  readonly #serverDirectory: string;

  /** @param serverDirectory - The server folder; the world goes to `<serverDirectory>/world`. */
  constructor(serverDirectory: string) {
    this.#serverDirectory = serverDirectory;
  }

  /**
   * Copies the save at `savePath` to the server's world folder.
   *
   * @param savePath - A singleplayer save folder (the one holding level.dat).
   * @param owner - The owner's Minecraft name, to carry their player data over; null to skip.
   * @param now - Used to name the backup of an existing server world.
   * @throws LabError when `savePath` is not a world, or the game still has it open.
   */
  import(savePath: string, owner: string | null, now: Date = new Date()): WorldImportReport {
    if (!existsSync(join(savePath, "level.dat"))) {
      throw new LabError(`${savePath} is not a Minecraft world (no level.dat).`);
    }
    const destination = join(this.#serverDirectory, "world");
    let backup: string | null = null;
    if (existsSync(destination)) {
      backup = `${destination}.backup-${now.toISOString().replace(/[:.]/g, "-")}`;
      renameSync(destination, backup);
    }
    cpSync(savePath, destination, {
      recursive: true,
      filter: (source) => basename(source) !== "session.lock",
    });
    const playerData = owner === null ? null : migratePlayerData(destination, owner);
    return { source: savePath, destination, backup, playerData };
  }
}

/** Copies the only player's data files to `owner`'s offline UUID. Returns what was copied, or null. */
function migratePlayerData(world: string, owner: string): { from: string; to: string } | null {
  const playerDir = join(world, "playerdata");
  if (!existsSync(playerDir)) {
    return null;
  }
  const players = readdirSync(playerDir)
    .filter((file) => /^[0-9a-f-]{36}\.dat$/.test(file))
    .map((file) => file.slice(0, 36));
  const target = offlineUuid(owner);
  const [only] = players;
  if (players.length !== 1 || only === undefined || only === target) {
    return null;
  }
  const copies: [string, string][] = [
    [join(playerDir, `${only}.dat`), join(playerDir, `${target}.dat`)],
    [join(world, "stats", `${only}.json`), join(world, "stats", `${target}.json`)],
    [join(world, "advancements", `${only}.json`), join(world, "advancements", `${target}.json`)],
  ];
  for (const [from, to] of copies) {
    if (existsSync(from)) {
      copyFileSync(from, to);
    }
  }
  return { from: only, to: target };
}
