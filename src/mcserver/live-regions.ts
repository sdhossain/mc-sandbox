import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import type { BlockPosition, BlockState, Box } from "../minecraft/types.ts";
import { LabError } from "../utils/errors.ts";
import { AnvilReader } from "./anvil-reader.ts";
import { baselineCells, captureBaseline, stateString, type RegionBaseline } from "./region-baseline.ts";

/** What a restore did. */
export interface RestoreReport {
  /** Commands sent; each sets one cell or a row of identical cells. */
  readonly commands: number;
  readonly durationMs: number;
}

/** Replies meaning a command did not run. "No entity was found" and "Could not set the block" (already that block) are fine. */
const FAILED_REPLY = /Unknown or incomplete command|Incorrect argument|<--\[HERE\]|not loaded|Invalid/i;

/**
 * Records and restores boxes of the live world while the server runs.
 *
 * Both keep the box's chunks loaded (`/forceload`), turn autosave off, have the server write the world to
 * disk, and read the blocks from the region files. A restore then sets only the cells that differ, in
 * `strict` mode, which skips neighbour updates: removing a floor does not make the torches on it drop,
 * and a door can be set one half at a time. It then removes dropped items in the box and writes the
 * world to disk, so that a server crash right after does not undo the restore (chunks a player stands
 * in are otherwise only written by the next autosave, up to 5 minutes later).
 */
export class LiveRegions {
  readonly #server: ServerControl;
  readonly #worldDir: string;

  /**
   * @param server - RCON to the server that owns the world.
   * @param worldDir - That server's world folder, read after `save-all flush`.
   */
  constructor(server: ServerControl, worldDir: string) {
    this.#server = server;
    this.#worldDir = worldDir;
  }

  /**
   * Records every block of `box` as it is now.
   *
   * @param source - Where the recording came from, kept in it (for example a run id).
   * @throws LabError when RCON is missing or part of the box was never generated.
   */
  async capture(box: Box, source: string): Promise<RegionBaseline> {
    return this.#withWorldOnDisk(box, (reader) =>
      Promise.resolve(captureBaseline(box, (position) => reader.blockAt(position), source)),
    );
  }

  /**
   * Puts the baseline's box back the way it was recorded.
   *
   * @throws LabError when RCON is missing or the server rejects a command.
   */
  async restore(baseline: RegionBaseline): Promise<RestoreReport> {
    const started = performance.now();
    const { min, max } = baseline.box;
    const commands = await this.#withWorldOnDisk(baseline.box, async (reader) => {
      const list = restoreCommands(baseline, (position) => reader.blockAt(position));
      for (const command of list) {
        await this.#run(command);
      }
      await this.#server.run(
        `kill @e[type=item,x=${min.x},y=${min.y},z=${min.z},dx=${max.x - min.x + 1},dy=${max.y - min.y + 1},dz=${max.z - min.z + 1}]`,
      );
      if (list.length > 0) {
        await this.#server.run("save-all flush");
      }
      return list;
    });
    return { commands: commands.length, durationMs: Math.round(performance.now() - started) };
  }

  /** Runs `action` with a reader of the world as just written to disk, while the box stays loaded. */
  async #withWorldOnDisk<T>(box: Box, action: (reader: AnvilReader) => Promise<T>): Promise<T> {
    if (!this.#server.available) {
      throw new LabError('Recording or restoring an area needs RCON; see docs/setup.md, "RCON".');
    }
    const area = `${box.min.x} ${box.min.z} ${box.max.x} ${box.max.z}`;
    await this.#run(`forceload add ${area}`);
    try {
      await this.#server.run("save-off");
      try {
        await this.#server.run("save-all flush");
        return await action(new AnvilReader(this.#worldDir));
      } finally {
        await this.#server.run("save-on");
      }
    } finally {
      await this.#server.run(`forceload remove ${area}`);
    }
  }

  async #run(command: string): Promise<void> {
    const reply = await this.#server.run(command);
    if (FAILED_REPLY.test(reply)) {
      throw new LabError(`The server rejected "/${command}": ${reply}`);
    }
  }
}

/**
 * Strict commands that set every cell whose current block differs from the baseline in name or any
 * block-state property; cells that cannot be read (never generated) are set too. Neighbouring cells
 * along x that need the same block share one `/fill`.
 */
export function restoreCommands(
  baseline: RegionBaseline,
  currentAt: (position: BlockPosition) => BlockState | null,
): string[] {
  const commands: string[] = [];
  // An open run of cells in the current row (same y and z) that all need `state`.
  let run: { y: number; z: number; x1: number; x2: number; state: string } | null = null;
  const close = (): void => {
    if (run !== null) {
      commands.push(
        run.x1 === run.x2
          ? `setblock ${run.x1} ${run.y} ${run.z} ${run.state} strict`
          : `fill ${run.x1} ${run.y} ${run.z} ${run.x2} ${run.y} ${run.z} ${run.state} strict`,
      );
      run = null;
    }
  };
  for (const { position, block } of baselineCells(baseline)) {
    const current = currentAt(position);
    const wanted = stateString(block);
    const differs = current === null || stateString(current) !== wanted;
    const continues =
      run !== null &&
      differs &&
      run.state === wanted &&
      run.y === position.y &&
      run.z === position.z &&
      run.x2 === position.x - 1;
    if (continues && run !== null) {
      run.x2 = position.x;
      continue;
    }
    close();
    if (differs) {
      run = { y: position.y, z: position.z, x1: position.x, x2: position.x, state: wanted };
    }
  }
  close();
  return commands;
}
