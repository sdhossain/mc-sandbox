import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import type { BlockPosition, BlockState, Box } from "../minecraft/types.ts";
import { LabError } from "../utils/errors.ts";

const PositionSchema = z.strictObject({ x: z.int(), y: z.int(), z: z.int() });

/**
 * Every block of a box at one moment, stored compactly: a palette of block states and one palette
 * index per cell. Cells are ordered x fastest, then z, then y.
 */
const RegionBaselineSchema = z
  .strictObject({
    schema: z.literal("mclab.baseline.v1"),
    box: z.strictObject({ min: PositionSchema, max: PositionSchema }),
    palette: z.array(z.strictObject({ name: z.string(), properties: z.record(z.string(), z.string()) })),
    cells: z.array(z.int().nonnegative()),
    /** Where it was captured from, for example a checkpoint id. */
    source: z.string(),
    capturedAt: z.string(),
  })
  .refine(
    ({ box: { min, max }, cells }) => cells.length === (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1),
    {
      message: "the number of cells does not match the box",
    },
  );

/** See {@link RegionBaselineSchema}. */
export type RegionBaseline = z.infer<typeof RegionBaselineSchema>;

/**
 * Captures every block of `box` through `blockAt`.
 *
 * @throws LabError when part of the box was never generated (its blocks are unknown).
 */
export function captureBaseline(
  box: Box,
  blockAt: (position: BlockPosition) => BlockState | null,
  source: string,
): RegionBaseline {
  const palette: BlockState[] = [];
  const indexOf = new Map<string, number>();
  const cells: number[] = [];
  for (const position of boxCells(box)) {
    const block = blockAt(position);
    if (block === null) {
      throw new LabError(
        `(${position.x}, ${position.y}, ${position.z}) has never been generated, so the baseline would be incomplete.`,
      );
    }
    const key = stateString(block);
    let index = indexOf.get(key);
    if (index === undefined) {
      index = palette.length;
      palette.push(block);
      indexOf.set(key, index);
    }
    cells.push(index);
  }
  return { schema: "mclab.baseline.v1", box, palette, cells, source, capturedAt: new Date().toISOString() };
}

/** The baseline's block at every position of its box. */
export function* baselineCells(baseline: RegionBaseline): Generator<{ position: BlockPosition; block: BlockState }> {
  let index = 0;
  for (const position of boxCells(baseline.box)) {
    const block = baseline.palette[baseline.cells[index] ?? -1];
    index += 1;
    if (block === undefined) {
      throw new LabError(`Baseline cell ${index} refers to a missing palette entry.`);
    }
    yield { position, block };
  }
}

/** Writes a baseline as gzipped JSON. */
export function writeBaseline(path: string, baseline: RegionBaseline): void {
  writeFileSync(path, gzipSync(JSON.stringify(baseline)));
}

/**
 * Reads a baseline written by {@link writeBaseline}.
 *
 * @throws LabError when the file is missing or not a baseline.
 */
export function readBaseline(path: string): RegionBaseline {
  let data: unknown;
  try {
    data = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
  } catch (error) {
    throw new LabError(`Cannot read the baseline ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = RegionBaselineSchema.safeParse(data);
  if (!parsed.success) {
    throw new LabError(`${path} is not a valid baseline: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
  }
  return parsed.data;
}

/** `name[key=value,...]`, the form `/setblock` takes; also the identity of a block state. */
export function stateString(block: BlockState): string {
  const entries = Object.entries(block.properties).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? block.name
    : `${block.name}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

/** Every position of a box: x fastest, then z, then y. */
export function* boxCells(box: Box): Generator<BlockPosition> {
  for (let y = box.min.y; y <= box.max.y; y += 1) {
    for (let z = box.min.z; z <= box.max.z; z += 1) {
      for (let x = box.min.x; x <= box.max.x; x += 1) {
        yield { x, y, z };
      }
    }
  }
}
