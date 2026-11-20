import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import { LabError } from "../utils/errors.ts";

/** Size and modification time of one world file when it was saved, used to skip unchanged files next time. */
interface FileRecord {
  readonly size: number;
  readonly mtimeMs: number;
}

/** What `checkpoint.json` records about one checkpoint. */
export interface CheckpointInfo {
  /** Directory name: a sortable UTC timestamp and the label, for example `20261119-174233_every-10-min`. */
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  /** The world's age in ticks when it was saved (`/time query gametime`), or null when the server did not say. */
  readonly gameTime: number | null;
  /** The checkpoint's world folder, a complete copy of the server's world. */
  readonly worldPath: string;
  readonly fileCount: number;
  /** Bytes copied because they changed since the previous checkpoint. */
  readonly copiedBytes: number;
  /** Bytes shared with the previous checkpoint through hard links, which take no extra space. */
  readonly linkedBytes: number;
  readonly durationMs: number;
  /** Anything else worth knowing, such as which runs were active. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, FileRecord>>;
}

/** Files the server holds open and that a copy must not include. */
const SKIPPED_FILES = new Set(["session.lock"]);
const INFO_FILE = "checkpoint.json";

/**
 * Saves complete copies of the server's world folder while the server runs.
 *
 * To get a consistent copy it turns autosave off, makes the server write every chunk and player to disk
 * (`save-all flush`), copies the folder, and turns autosave back on. Files that have not changed since
 * the previous checkpoint are hard-linked instead of copied, so a checkpoint costs only the region files
 * that changed. Saved files are made read-only, because hard-linked files are shared between
 * checkpoints; {@link openCopy} makes a writable copy to open in Minecraft.
 */
export class WorldCheckpointer {
  readonly #server: ServerControl;
  readonly #worldDir: string;
  readonly #storeDir: string;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @param server - RCON to the server that owns the world; checkpoints cannot be taken without it.
   * @param worldDir - The server's world folder, for example `server/world`.
   * @param storeDir - Where checkpoints are kept, for example `checkpoints`.
   */
  constructor(server: ServerControl, worldDir: string, storeDir: string) {
    this.#server = server;
    this.#worldDir = worldDir;
    this.#storeDir = storeDir;
  }

  /** Where checkpoints are kept. */
  get storeDir(): string {
    return this.#storeDir;
  }

  /**
   * Saves a checkpoint now. Saves never overlap: a second call waits for the first.
   *
   * @param label - A short name, kept in the checkpoint's id.
   * @param details - Extra facts recorded in `checkpoint.json`, such as the active runs.
   * @throws LabError when RCON is unavailable or the world folder is missing.
   */
  save(label: string, details: Readonly<Record<string, unknown>> = {}): Promise<CheckpointInfo> {
    const saving = this.#queue.then(() => this.#save(label, details));
    this.#queue = saving.catch(() => undefined);
    return saving;
  }

  /** Every checkpoint in the store, oldest first. */
  list(): CheckpointInfo[] {
    if (!existsSync(this.#storeDir)) {
      return [];
    }
    return readdirSync(this.#storeDir)
      .sort()
      .filter((id) => existsSync(join(this.#storeDir, id, INFO_FILE)))
      .map((id) => JSON.parse(readFileSync(join(this.#storeDir, id, INFO_FILE), "utf8")) as CheckpointInfo);
  }

  /**
   * Copies a checkpoint's world into `savesDir`, writable, so Minecraft can open it in singleplayer.
   *
   * @returns The new world folder.
   * @throws LabError when the checkpoint does not exist or the destination already does.
   */
  openCopy(id: string, savesDir: string): string {
    const source = join(this.#storeDir, id, "world");
    if (!existsSync(source)) {
      throw new LabError(`No checkpoint "${id}" in ${this.#storeDir}. List them with: npm run lab -- checkpoint list`);
    }
    const destination = join(savesDir, `mclab-${id}`);
    if (existsSync(destination)) {
      throw new LabError(`${destination} already exists.`);
    }
    for (const file of walk(source)) {
      const target = join(destination, relative(source, file));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      chmodSync(target, 0o644);
    }
    return destination;
  }

  /** `id`, or `id-2`, `id-3`... when a checkpoint with the same second and label exists. */
  #freeId(id: string): string {
    let candidate = id;
    for (let suffix = 2; existsSync(join(this.#storeDir, candidate)); suffix += 1) {
      candidate = `${id}-${suffix}`;
    }
    return candidate;
  }

  async #save(label: string, details: Readonly<Record<string, unknown>>): Promise<CheckpointInfo> {
    if (!this.#server.available) {
      throw new LabError(
        'Checkpoints need RCON to make the server write the world to disk; see docs/setup.md, "RCON".',
      );
    }
    if (!existsSync(join(this.#worldDir, "level.dat"))) {
      throw new LabError(`No world at ${this.#worldDir} (level.dat is missing).`);
    }
    const started = performance.now();
    const createdAt = new Date();
    const id = this.#freeId(`${timestamp(createdAt)}_${slug(label)}`);
    const previous = this.list().at(-1);
    await this.#server.run("save-off");
    try {
      await this.#server.run("save-all flush");
      const gameTime = parseGameTime(await this.#server.run("time query gametime"));
      const worldPath = join(this.#storeDir, id, "world");
      const copy = copyWorld(this.#worldDir, worldPath, previous);
      const info: CheckpointInfo = {
        id,
        label,
        createdAt: createdAt.toISOString(),
        gameTime,
        worldPath,
        fileCount: Object.keys(copy.files).length,
        copiedBytes: copy.copiedBytes,
        linkedBytes: copy.linkedBytes,
        durationMs: Math.round(performance.now() - started),
        details,
        files: copy.files,
      };
      writeFileSync(join(this.#storeDir, id, INFO_FILE), `${JSON.stringify(info, null, 1)}\n`);
      return info;
    } finally {
      await this.#server.run("save-on");
    }
  }
}

/** Copies `source` to `destination`, hard-linking files unchanged since `previous`. */
function copyWorld(
  source: string,
  destination: string,
  previous: CheckpointInfo | undefined,
): { files: Record<string, FileRecord>; copiedBytes: number; linkedBytes: number } {
  const files: Record<string, FileRecord> = {};
  let copiedBytes = 0;
  let linkedBytes = 0;
  for (const file of walk(source)) {
    const path = relative(source, file);
    const stats = statSync(file);
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    const before = previous?.files[path];
    const previousCopy = previous === undefined ? undefined : join(previous.worldPath, path);
    if (
      before?.size === stats.size &&
      before.mtimeMs === stats.mtimeMs &&
      previousCopy !== undefined &&
      existsSync(previousCopy)
    ) {
      linkSync(previousCopy, target);
      linkedBytes += stats.size;
    } else {
      copyFileSync(file, target);
      chmodSync(target, 0o444);
      copiedBytes += stats.size;
    }
    files[path] = { size: stats.size, mtimeMs: stats.mtimeMs };
  }
  return { files, copiedBytes, linkedBytes };
}

/** Every file under `directory`, except ones the server holds open. */
function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && !SKIPPED_FILES.has(entry.name)) {
      yield path;
    }
  }
}

/** Parses "The time is 123456" from `/time query gametime`. */
function parseGameTime(reply: string): number | null {
  const match = /(\d+)\s*$/.exec(reply.trim());
  return match === null ? null : Number(match[1]);
}

/** `20261119-174233`, in UTC like run ids, so checkpoints sort by when they were taken. */
function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "checkpoint"
  );
}
