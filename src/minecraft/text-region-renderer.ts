import { ActionError } from "../utils/errors.ts";
import type { RegionRenderer, RenderOptions } from "./game-services.ts";
import {
  boxVolume,
  formatBlockState,
  formatPosition,
  isAir,
  type BlockPosition,
  type BlockState,
  type Box,
} from "./types.ts";

/** Reads one block; null when its chunk is not loaded. */
export type BlockReader = (position: BlockPosition) => BlockState | null;

const DEFAULT_MAX_CELLS = 8_192;
/** Block-state properties that change a block's shape and so get their own legend symbol. */
const SHAPE_PROPERTIES = ["facing", "half", "type", "axis"] as const;
const AIR_SYMBOL = ".";
const UNLOADED_SYMBOL = "~";
const OVERFLOW_SYMBOL = "?";
const SYMBOLS = "#@%&*+=$ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!:;<>^/|";

/**
 * Renders a box as text, one top-down grid per y layer, bottom layer first.
 *
 * Rows are z (north at the top) and columns are x (west at the left), with absolute coordinates on
 * every row and column, because index and orientation mistakes are the commonest failure of models
 * reading 3D structures. Layers that are entirely air are collapsed to one line.
 */
export class TextRegionRenderer implements RegionRenderer {
  readonly #read: BlockReader;

  /** @param read - Reads blocks from the world (or from a fake world in tests). */
  constructor(read: BlockReader) {
    this.#read = read;
  }

  /** Renders `box`; throws `ActionError` with a split suggestion when it has too many cells. */
  render(box: Box, options: RenderOptions = {}): string {
    const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
    const cells = boxVolume(box);
    if (cells > maxCells) {
      throw new ActionError(
        `The region has ${cells} cells, over the limit of ${maxCells}. Inspect it in parts, for example a few y layers at a time.`,
      );
    }
    const legend = new Legend();
    const width = box.max.x - box.min.x + 1;
    const height = box.max.y - box.min.y + 1;
    const depth = box.max.z - box.min.z + 1;
    const cellWidth = Math.max(3, ...[box.min.x, box.max.x].map((x) => String(x).length + 1));
    const rowLabelWidth = Math.max(...[box.min.z, box.max.z].map((z) => `z=${z}`.length));

    const layers: string[] = [];
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      const rows: string[] = [];
      let allAir = true;
      for (let z = box.min.z; z <= box.max.z; z += 1) {
        let row = `z=${z}`.padStart(rowLabelWidth);
        for (let x = box.min.x; x <= box.max.x; x += 1) {
          const symbol = legend.symbolFor(this.#read({ x, y, z }));
          allAir &&= symbol === AIR_SYMBOL;
          row += symbol.padStart(cellWidth);
        }
        rows.push(row);
      }
      if (allAir) {
        layers.push(`y=${y}: all air`);
        continue;
      }
      let header = "x=".padStart(rowLabelWidth);
      for (let x = box.min.x; x <= box.max.x; x += 1) {
        header += String(x).padStart(cellWidth);
      }
      layers.push([`y=${y}`, header, ...rows].join("\n"));
    }

    return [
      `Region ${formatPosition(box.min)} to ${formatPosition(box.max)}: ${width} x (east-west) by ${height} y by ${depth} z (north-south), ${cells} cells.`,
      "Each layer is seen from above: rows are z with north at the top, columns are x with west at the left.",
      `Legend: ${legend.describe()}`,
      "",
      layers.join("\n\n"),
    ].join("\n");
  }
}

/** Assigns one-character symbols to block states in order of first appearance. */
class Legend {
  readonly #symbols = new Map<string, string>([["air", AIR_SYMBOL]]);
  readonly #overflow = new Set<string>();
  #unloaded = false;

  symbolFor(state: BlockState | null): string {
    if (state === null) {
      this.#unloaded = true;
      return UNLOADED_SYMBOL;
    }
    if (isAir(state.name)) {
      return AIR_SYMBOL;
    }
    const key = shapeKey(state);
    const existing = this.#symbols.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const next = SYMBOLS[this.#symbols.size - 1];
    if (next === undefined) {
      this.#overflow.add(key);
      return OVERFLOW_SYMBOL;
    }
    this.#symbols.set(key, next);
    return next;
  }

  describe(): string {
    const entries = [...this.#symbols.entries()].map(([key, symbol]) => `${symbol} ${key}`);
    if (this.#unloaded) {
      entries.push(`${UNLOADED_SYMBOL} not loaded`);
    }
    if (this.#overflow.size > 0) {
      entries.push(`${OVERFLOW_SYMBOL} one of ${this.#overflow.size} more kinds (use block_info)`);
    }
    return entries.join(" | ");
  }
}

/** The legend key of a block: its name plus the properties that change its shape. */
function shapeKey(state: BlockState): string {
  const properties: Record<string, string> = {};
  for (const name of SHAPE_PROPERTIES) {
    const value = state.properties[name];
    if (value !== undefined) {
      properties[name] = value;
    }
  }
  return formatBlockState({ name: state.name, properties });
}
