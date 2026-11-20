import type { BlockChangeRecorder, WorldScanner } from "../minecraft/game-services.ts";
import {
  boxVolume,
  ChangeCause,
  isAir,
  type BlockChange,
  type Box,
  type RegionSnapshot,
  type SnapshotRow,
} from "../minecraft/types.ts";

/** Margin around the changed blocks, so leftover scaffolding and neighbouring context are included. */
const MARGIN = 2;
/** Larger boxes are not snapshotted; the change log still has every change. */
const MAX_CELLS = 262_144;

/** Before and after snapshots of the region a turn changed. */
export interface TurnSnapshots {
  readonly box: Box;
  readonly before: RegionSnapshot;
  readonly after: RegionSnapshot;
  readonly changes: number;
}

/**
 * Captures what a turn built: the box around every block that changed during the turn, as it is now
 * and as it was before (reconstructed by undoing the turn's changes, so nothing has to be scanned
 * before the turn starts).
 *
 * The snapshots use the `mclab.snapshot.v1` format.
 */
export class BuildSnapshotter {
  readonly #scanner: WorldScanner;
  readonly #changes: BlockChangeRecorder;

  /**
   * @param scanner - Reads the current world.
   * @param changes - The change log of the same bot.
   */
  constructor(scanner: WorldScanner, changes: BlockChangeRecorder) {
    this.#scanner = scanner;
    this.#changes = changes;
  }

  /**
   * Snapshots the region the bot changed after `sinceSeq`; null when the bot changed nothing or the
   * region is too large.
   *
   * The box is drawn around the bot's own changes only: crops grow, leaves decay and water flows all
   * over the loaded world, and boxing those too would make the snapshot huge. Other changes inside the
   * box (the owner's, for example) are still undone to rebuild the "before" state.
   */
  capture(sinceSeq: number): TurnSnapshots | null {
    const byBot = this.#changes.since(sinceSeq).filter((change) => change.cause === ChangeCause.BOT);
    if (byBot.length === 0) {
      return null;
    }
    const box = boundingBox(byBot, MARGIN);
    if (boxVolume(box) > MAX_CELLS) {
      return null;
    }
    const changesInBox = this.#changes.since(sinceSeq, box);
    const after = this.#scanner.snapshot(box, MAX_CELLS);
    return { box, after, before: undoChanges(after, changesInBox), changes: changesInBox.length };
  }
}

/** The box around every changed position, grown by `margin` on each side. */
export function boundingBox(changes: readonly BlockChange[], margin: number): Box {
  const xs = changes.map((change) => change.position.x);
  const ys = changes.map((change) => change.position.y);
  const zs = changes.map((change) => change.position.z);
  return {
    min: { x: Math.min(...xs) - margin, y: Math.min(...ys) - margin, z: Math.min(...zs) - margin },
    max: { x: Math.max(...xs) + margin, y: Math.max(...ys) + margin, z: Math.max(...zs) + margin },
  };
}

/** Reconstructs the region before `changes` by applying them backwards to `after`. */
export function undoChanges(after: RegionSnapshot, changes: readonly BlockChange[]): RegionSnapshot {
  const cells = new Map<string, SnapshotRow>();
  for (const row of after.blocks) {
    cells.set(`${row[0]},${row[1]},${row[2]}`, row);
  }
  for (const change of [...changes].reverse()) {
    const { x, y, z } = change.position;
    const key = `${x},${y},${z}`;
    if (change.before === null || isAir(change.before.name)) {
      cells.delete(key);
    } else {
      cells.set(key, [x, y, z, change.before.name, change.before.properties]);
    }
  }
  const blocks = [...cells.values()].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  const firstTick = changes[0]?.gameTick ?? after.gameTick;
  return { ...after, takenAtMs: changes[0]?.timeMs ?? after.takenAtMs, gameTick: firstTick, blocks };
}
