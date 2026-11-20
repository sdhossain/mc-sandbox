/**
 * Line of sight through a block world: can an eye see any part of a block?
 *
 * Used by the `hidden` case check. A block counts as seen when any of a grid of points on its faces
 * that look toward the eye can be reached by a straight line that passes through no occluding block.
 */

import type { BlockPosition, Position } from "../minecraft/types.ts";

/** Tells whether the block at a position hides what is behind it. */
export type OccluderTest = (position: BlockPosition) => boolean;

/** Fractions along each face edge where sample points sit; inset so lines do not graze block edges. */
const FACE_SAMPLES = [0.08, 0.36, 0.64, 0.92] as const;
/** How far outside the face a sample point sits, so the line ends in the cell next to the face. */
const FACE_OFFSET = 0.001;
const MAX_STEPS = 10_000;

const FACES: readonly { normal: Position; u: Position; v: Position }[] = [
  { normal: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { normal: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { normal: { x: 0, y: 1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { normal: { x: 0, y: -1, z: 0 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } },
  { normal: { x: 0, y: 0, z: 1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  { normal: { x: 0, y: 0, z: -1 }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
];

/**
 * A point on `block` that `eye` can see, or null when the whole block is hidden.
 *
 * @param isOccluder - True for blocks that hide what is behind them (full, opaque cubes).
 */
export function visiblePoint(eye: Position, block: BlockPosition, isOccluder: OccluderTest): Position | null {
  for (const point of facePoints(eye, block)) {
    if (!isBlocked(eye, point, isOccluder)) {
      return point;
    }
  }
  return null;
}

/** Sample points just outside every face of `block` that faces the eye. */
function* facePoints(eye: Position, block: BlockPosition): Generator<Position> {
  for (const { normal, u, v } of FACES) {
    // The face's centre: the block centre moved half a block along the normal.
    const center = {
      x: block.x + 0.5 + normal.x * 0.5,
      y: block.y + 0.5 + normal.y * 0.5,
      z: block.z + 0.5 + normal.z * 0.5,
    };
    const towardEye = (eye.x - center.x) * normal.x + (eye.y - center.y) * normal.y + (eye.z - center.z) * normal.z;
    if (towardEye <= 0) {
      continue;
    }
    for (const a of FACE_SAMPLES) {
      for (const b of FACE_SAMPLES) {
        yield {
          x: center.x + (a - 0.5) * u.x + (b - 0.5) * v.x + normal.x * FACE_OFFSET,
          y: center.y + (a - 0.5) * u.y + (b - 0.5) * v.y + normal.y * FACE_OFFSET,
          z: center.z + (a - 0.5) * u.z + (b - 0.5) * v.z + normal.z * FACE_OFFSET,
        };
      }
    }
  }
}

/** True when an occluding block lies on the segment from `from` to `to`, not counting the eye's own cell. */
function isBlocked(from: Position, to: Position, isOccluder: OccluderTest): boolean {
  let first = true;
  for (const cell of cellsOnSegment(from, to)) {
    if (!first && isOccluder(cell)) {
      return true;
    }
    first = false;
  }
  return false;
}

/** The cells a straight segment passes through, in order (Amanatides and Woo's voxel traversal). */
export function* cellsOnSegment(from: Position, to: Position): Generator<BlockPosition> {
  const cell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  const end = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
  const axes = ["x", "y", "z"] as const;
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const step = { x: Math.sign(delta.x), y: Math.sign(delta.y), z: Math.sign(delta.z) };
  // tMax: how far along the segment (0..1) the next cell boundary on each axis is; tDelta: one cell's worth.
  const tMax = { x: Infinity, y: Infinity, z: Infinity };
  const tDelta = { x: Infinity, y: Infinity, z: Infinity };
  for (const axis of axes) {
    if (step[axis] !== 0) {
      const boundary = step[axis] > 0 ? cell[axis] + 1 : cell[axis];
      tMax[axis] = (boundary - from[axis]) / delta[axis];
      tDelta[axis] = 1 / Math.abs(delta[axis]);
    }
  }
  yield { ...cell };
  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    if (cell.x === end.x && cell.y === end.y && cell.z === end.z) {
      return;
    }
    const axis = axes.reduce((best, candidate) => (tMax[candidate] < tMax[best] ? candidate : best));
    if (tMax[axis] > 1) {
      return;
    }
    cell[axis] += step[axis];
    tMax[axis] += tDelta[axis];
    yield { ...cell };
  }
}
