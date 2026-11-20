/**
 * Evaluates a case's checks against the world as the bot sees it.
 *
 * Everything here is a pure function of a {@link CaseWorld}, so checks are unit-tested without a server.
 */

import {
  boxFromCorners,
  formatBlockState,
  isAir,
  type BlockPosition,
  type BlockState,
  type Box,
} from "../minecraft/types.ts";
import { atOffset, describeNames, nameMatcher, type CaseCheck, type CaseDefinition } from "./case-definition.ts";
import { visiblePoint } from "./line-of-sight.ts";

/** What the checks read. */
export interface CaseWorld {
  /** The block at a position, or null when its chunk is not loaded. */
  blockAt(position: BlockPosition): BlockState | null;
  /** How many of an item the bot holds. */
  inventoryCount(item: string): number;
  /** True for blocks that hide what is behind them: full, opaque cubes. */
  isOccluder(blockName: string): boolean;
}

/** The blocks of a box at one moment, keyed by `x,y,z`; air cells are absent. */
export type BlockMap = ReadonlyMap<string, BlockState>;

/** A box as it was right after setup (`intended`) and as the agent first saw it, after any damage (`presented`). */
export interface Baseline {
  readonly intended: BlockMap;
  readonly presented: BlockMap;
}

/** What the runner recorded while building the scene. */
export interface SceneRecord {
  readonly anchor: BlockPosition;
  /**
   * By check index: for `restored` and `unchanged` checks their box, and for `copy` checks every cell the
   * copy may occupy ({@link copyTargetBox}), as they were before the agent started.
   */
  readonly baselines: ReadonlyMap<number, Baseline>;
}

/** The outcome of one check. */
export interface CheckResult {
  readonly label: string;
  readonly passed: boolean;
  /** What was found, in absolute coordinates with the offset from the anchor in brackets. */
  readonly detail: string;
  /** The check's numbers, for tables across runs: for a copy check, cells matched and so on. */
  readonly metrics?: Readonly<Record<string, number>>;
}

/** The outcome of every check of a case, after one turn. */
export interface CaseResult {
  readonly caseId: string;
  readonly turn: number;
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
}

/** Block-state keys that matter when comparing builds; other properties are ignored. */
const COMPARED_PROPERTIES = ["facing", "half", "type", "axis"] as const;
/** Soil counts as one kind of ground: grass under a newly placed block turns to dirt by itself. */
const SOIL = new Set(["grass_block", "dirt", "coarse_dirt", "podzol", "rooted_dirt", "dirt_path", "farmland"]);
/** Mismatched positions listed in a detail before the rest are only counted. */
const MAX_LISTED = 6;
/** Horizontal directions in clockwise order, seen from above. */
const CLOCKWISE = ["north", "east", "south", "west"] as const;

/** The context every check gets. */
interface CheckContext {
  readonly definition: CaseDefinition;
  readonly scene: SceneRecord;
  readonly world: CaseWorld;
  readonly finalReply: string;
}

/** Evaluates every check of `definition`. A case without checks never passes (it is judged by eye). */
export function evaluateCase(
  definition: CaseDefinition,
  scene: SceneRecord,
  world: CaseWorld,
  finalReply: string,
  turn: number,
): CaseResult {
  const context: CheckContext = { definition, scene, world, finalReply };
  const checks = definition.checks.map((check, index) => evaluateCheck(check, index, context));
  return {
    caseId: definition.id,
    turn,
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
  };
}

/** One line per check, for chat and the terminal. */
export function summariseResult(result: CaseResult): string {
  if (result.checks.length === 0) {
    return `Case ${result.caseId}: no automatic checks; judge it from the transcript.`;
  }
  const passed = result.checks.filter((check) => check.passed).length;
  const failed = result.checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.detail}`);
  const verdict = result.passed ? "PASS" : "FAIL";
  return [`Case ${result.caseId}: ${verdict} (${passed}/${result.checks.length} checks)`, ...failed].join(" | ");
}

/**
 * True when two cells hold the same block for building purposes: same name and the same values for the
 * compared state keys the intended block has. Air of any kind, and a snow layer (which falls on its own
 * in snowy biomes), count as empty.
 */
export function sameBlock(
  intended: BlockState | null,
  actual: BlockState | null,
  keys: readonly string[] = COMPARED_PROPERTIES,
): boolean {
  const a = isEmpty(intended) ? null : intended;
  const b = isEmpty(actual) ? null : actual;
  if (a === null || b === null) {
    return a === b;
  }
  if (a.name !== b.name) {
    return false;
  }
  return keys.every((key) => a.properties[key] === undefined || a.properties[key] === b.properties[key]);
}

/** The blocks of a box as a map, from a snapshot's rows. */
export function toBlockMap(
  rows: Iterable<readonly [number, number, number, string, Readonly<Record<string, string>>]>,
): BlockMap {
  const map = new Map<string, BlockState>();
  for (const [x, y, z, name, properties] of rows) {
    map.set(keyOf({ x, y, z }), { name, properties });
  }
  return map;
}

function evaluateCheck(check: CaseCheck, index: number, context: CheckContext): CheckResult {
  const { anchor } = context.scene;
  const box = (from: [number, number, number], to: [number, number, number]): Box =>
    boxFromCorners(atOffset(anchor, from), atOffset(anchor, to));
  if ("block" in check) {
    return checkBlock(check.block, check.label, context);
  }
  if ("count" in check) {
    return checkCount(check.count, box(check.count.from, check.count.to), check.label, context);
  }
  if ("inventory" in check) {
    const held = context.world.inventoryCount(check.inventory.item);
    return {
      label: check.label ?? `holds ${check.inventory.min} ${check.inventory.item}`,
      passed: held >= check.inventory.min,
      detail: `holds ${held}`,
    };
  }
  if ("reply" in check) {
    const reply = context.finalReply;
    return {
      label: check.label ?? `reply matches /${check.reply.matches}/`,
      passed: new RegExp(check.reply.matches, "i").test(reply),
      detail: reply === "" ? "no reply" : `reply: "${reply}"`,
    };
  }
  if ("restored" in check || "unchanged" in check) {
    const baseline = context.scene.baselines.get(index);
    const corners = "restored" in check ? check.restored : check.unchanged;
    if (baseline === undefined) {
      return { label: check.label ?? "scene baseline", passed: false, detail: "no baseline was recorded" };
    }
    return "restored" in check
      ? checkRestored(box(corners.from, corners.to), baseline, check.label, context)
      : checkUnchanged(box(corners.from, corners.to), baseline, check.label, context);
  }
  if ("copy" in check) {
    return checkCopy(
      box(check.copy.from, check.copy.to),
      check.copy,
      check.label,
      context.scene.baselines.get(index),
      context,
    );
  }
  if ("hidden" in check) {
    return checkHidden(check.hidden, check.label, context);
  }
  return checkRing(check.ring, check.label, context);
}

function checkBlock(
  spec: { at: [number, number, number]; is: string | string[]; props?: Record<string, string> | undefined },
  label: string | undefined,
  { definition, scene, world }: CheckContext,
): CheckResult {
  const { anchor } = scene;
  const matches = nameMatcher(spec.is);
  const position = atOffset(anchor, spec.at);
  const found = world.blockAt(position);
  const wanted = describeNames(spec.is) + (spec.props === undefined ? "" : `[${formatProps(spec.props)}]`);
  const nameOk = found !== null && (matches(found.name) || (matches("air") && isEmpty(found)));
  const propsOk =
    found !== null && Object.entries(spec.props ?? {}).every(([key, value]) => found.properties[key] === value);
  let detail = `${where(position, anchor)} is ${describe(found)}`;
  if (!nameOk && !matches("air")) {
    const elsewhere = findInSite(matches, definition, anchor, world).filter(
      (other) => keyOf(other) !== keyOf(position),
    );
    if (elsewhere.length > 0) {
      detail += `; ${describeNames(spec.is)} found at ${listSome(elsewhere.map((other) => where(other, anchor)))}`;
    }
  }
  return { label: label ?? `${wanted} at ${offsetText(spec.at)}`, passed: nameOk && propsOk, detail };
}

function checkCount(
  spec: {
    block: string | string[];
    from: [number, number, number];
    to: [number, number, number];
    equals?: number | undefined;
    min?: number | undefined;
    max?: number | undefined;
  },
  box: Box,
  label: string | undefined,
  { world }: CheckContext,
): CheckResult {
  const matches = nameMatcher(spec.block);
  let count = 0;
  for (const position of cells(box)) {
    const block = world.blockAt(position);
    if (block !== null && !isEmpty(block) && matches(block.name)) {
      count += 1;
    }
  }
  const passed =
    (spec.equals === undefined || count === spec.equals) &&
    (spec.min === undefined || count >= spec.min) &&
    (spec.max === undefined || count <= spec.max);
  const range =
    spec.equals === undefined
      ? [spec.min === undefined ? "" : `at least ${spec.min}`, spec.max === undefined ? "" : `at most ${spec.max}`]
          .filter((part) => part !== "")
          .join(" and ")
      : `exactly ${spec.equals}`;
  return {
    label: label ?? `${range} ${describeNames(spec.block)} in ${offsetText(spec.from)}..${offsetText(spec.to)}`,
    passed,
    detail: `found ${count}`,
  };
}

function checkRestored(
  box: Box,
  baseline: Baseline,
  label: string | undefined,
  { scene, world }: CheckContext,
): CheckResult {
  let needed = 0;
  let restored = 0;
  const wrong: string[] = [];
  const collateral: string[] = [];
  for (const position of cells(box)) {
    const goal = baseline.intended.get(keyOf(position)) ?? null;
    const now = world.blockAt(position);
    if (!sameBlock(goal, baseline.presented.get(keyOf(position)) ?? null)) {
      needed += 1;
      if (sameBlock(goal, now)) {
        restored += 1;
      } else {
        wrong.push(`${where(position, scene.anchor)} is ${describe(now)}, was ${describe(goal)}`);
      }
    } else if (!sameBlock(goal, now)) {
      collateral.push(`${where(position, scene.anchor)} became ${describe(now)}, was ${describe(goal)}`);
    }
  }
  const parts = [`restored ${restored} of ${needed} damaged cells`];
  if (wrong.length > 0) {
    parts.push(`not restored: ${listSome(wrong)}`);
  }
  parts.push(
    `${collateral.length} changes outside the damage${collateral.length > 0 ? `: ${listSome(collateral)}` : ""}`,
  );
  return {
    label: label ?? "damage repaired, nothing else changed",
    passed: needed > 0 && restored === needed && collateral.length === 0,
    detail: parts.join("; "),
  };
}

function checkUnchanged(
  box: Box,
  baseline: Baseline,
  label: string | undefined,
  { scene, world }: CheckContext,
): CheckResult {
  const changes: string[] = [];
  for (const position of cells(box)) {
    const before = baseline.presented.get(keyOf(position)) ?? null;
    const now = world.blockAt(position);
    if (!sameBlock(before, now)) {
      changes.push(`${where(position, scene.anchor)} became ${describe(now)}, was ${describe(before)}`);
    }
  }
  return {
    label: label ?? "left unchanged",
    passed: changes.length === 0,
    detail: changes.length === 0 ? "unchanged" : `${changes.length} changed: ${listSome(changes)}`,
  };
}

/** The settings of a `copy` check, after defaults. */
export interface CopySpec {
  from: [number, number, number];
  to: [number, number, number];
  offset: [number, number, number];
  mirror?: { axis: "x" | "z"; about: number } | undefined;
  rotate?: { clockwise: 90 | 180 | 270; at: [number, number, number] } | undefined;
  searchY?: [number, number] | undefined;
  ignore?: string | string[] | undefined;
  ignoreProperties: string[];
}

/** Maps a source cell to its place in the copy and the block expected there. */
type CopyTransform = (
  position: BlockPosition,
  block: BlockState | null,
) => { target: BlockPosition; expected: BlockState | null };

/**
 * Every cell a `copy` check may compare in the copy: the box the copy can occupy at any of its allowed
 * heights. The scene's blocks there are recorded before the agent starts, so that ground the agent never
 * touched is not counted against the copy.
 */
export function copyTargetBox(spec: CopySpec, anchor: BlockPosition): Box {
  const source = boxFromCorners(atOffset(anchor, spec.from), atOffset(anchor, spec.to));
  const heights = spec.searchY ?? [spec.offset[1], spec.offset[1]];
  const corners = heights.flatMap((dy) => {
    const transform = copyTransform(source, { ...spec, offset: [spec.offset[0], dy, spec.offset[2]] }, anchor);
    return [transform(source.min, null).target, transform(source.max, null).target];
  });
  const extreme = (pick: (...values: number[]) => number, axis: "x" | "y" | "z"): number =>
    pick(...corners.map((corner) => corner[axis]));
  return boxFromCorners(
    { x: extreme(Math.min, "x"), y: extreme(Math.min, "y"), z: extreme(Math.min, "z") },
    { x: extreme(Math.max, "x"), y: extreme(Math.max, "y"), z: extreme(Math.max, "z") },
  );
}

/**
 * The box whose blocks before the agent started a check compares with: the box of a `restored` or
 * `unchanged` check, or every cell a `copy` check's copy may occupy. Null for the other checks.
 */
export function baselineBoxOf(check: CaseCheck, anchor: BlockPosition): Box | null {
  if ("restored" in check || "unchanged" in check) {
    const corners = "restored" in check ? check.restored : check.unchanged;
    return boxFromCorners(atOffset(anchor, corners.from), atOffset(anchor, corners.to));
  }
  return "copy" in check ? copyTargetBox(check.copy, anchor) : null;
}

/**
 * Scores a copy of the source box. A cell that should be empty but holds the same block as before the
 * agent started is untouched ground (the copy may stand on a slope): it is neither extra nor wrong.
 *
 * @param start - The copy's cells before the agent started ({@link copyTargetBox}); without it, every
 *   block in a cell that should be empty counts as extra.
 */
function checkCopy(
  source: Box,
  spec: CopySpec,
  label: string | undefined,
  start: Baseline | undefined,
  { scene, world }: CheckContext,
): CheckResult {
  const { anchor } = scene;
  const ignored = spec.ignore === undefined ? (): boolean => false : nameMatcher(spec.ignore);
  const keys = COMPARED_PROPERTIES.filter((key) => !spec.ignoreProperties.includes(key));
  /**
   * Cells compared; matches; the original's blocks and how many of them the copy has right; extra
   * blocks; cells of untouched ground; the cells that are wrong.
   */
  interface Score {
    total: number;
    matching: number;
    blocks: number;
    blocksRight: number;
    extra: number;
    ground: number;
    wrong: string[];
  }
  const score = (transform: CopyTransform): Score => {
    const result: Score = { total: 0, matching: 0, blocks: 0, blocksRight: 0, extra: 0, ground: 0, wrong: [] };
    for (const position of cells(source)) {
      const original = world.blockAt(position);
      const { target, expected } = transform(position, original);
      const copy = world.blockAt(target);
      if ((original !== null && ignored(original.name)) || (copy !== null && ignored(copy.name))) {
        continue;
      }
      const match = sameBlock(expected, copy, keys);
      result.total += 1;
      if (match) {
        result.matching += 1;
      }
      if (isEmpty(expected)) {
        if (copy !== null && !isEmpty(copy) && untouchedGround(copy, start?.presented.get(keyOf(target)) ?? null)) {
          result.ground += 1;
          continue;
        }
        result.extra += isEmpty(copy) ? 0 : 1;
      } else {
        result.blocks += 1;
        result.blocksRight += match ? 1 : 0;
      }
      if (!match) {
        result.wrong.push(`${where(target, anchor)} is ${describe(copy)}, should be ${describe(expected)}`);
      }
    }
    return result;
  };
  // With searchY, the copy may stand at any of several heights: keep the height that matches best.
  const heights = spec.searchY === undefined ? [spec.offset[1]] : range(spec.searchY[0], spec.searchY[1]);
  const scored = heights.map((dy) => {
    const placed = { ...spec, offset: [spec.offset[0], dy, spec.offset[2]] as [number, number, number] };
    return { dy, ...score(copyTransform(source, placed, anchor)) };
  });
  const best = scored.reduce((winner, candidate) => (candidate.matching > winner.matching ? candidate : winner));
  const placedSpec = { ...spec, offset: [spec.offset[0], best.dy, spec.offset[2]] as [number, number, number] };
  let what = `exact copy shifted by ${offsetText(spec.offset)}`;
  if (spec.mirror !== undefined) {
    what = `mirror image across ${spec.mirror.axis} = ${anchor[spec.mirror.axis] + spec.mirror.about}`;
  } else if (spec.rotate !== undefined) {
    what = `copy turned ${spec.rotate.clockwise} degrees clockwise at ${offsetText(spec.rotate.at)}`;
  }
  const height = spec.searchY === undefined ? "" : ` with the copy's bottom layer at y = ${source.min.y + best.dy}`;
  const parts = [
    `${best.blocksRight} of the original's ${best.blocks} blocks right, ${best.extra} extra (${best.matching} of ${best.total} cells match${height})`,
  ];
  if (best.ground > 0) {
    parts.push(`${best.ground} cells of untouched ground in the copy's box not counted`);
  }
  if (best.wrong.length > 0) {
    parts.push(listSome(best.wrong));
  }
  const metrics: Record<string, number> = {
    matching: best.matching,
    total: best.total,
    wrongCells: best.wrong.length,
    blocksRight: best.blocksRight,
    blocks: best.blocks,
    extraBlocks: best.extra,
    groundCells: best.ground,
    bottomY: source.min.y + best.dy,
  };
  if (spec.mirror !== undefined) {
    // The same place without mirroring: if this scores higher, the model copied instead of mirroring.
    const plain = score(plainTransformOnto(source, copyTransform(source, placedSpec, anchor)));
    parts.push(`a plain, unmirrored copy in the same place would match ${plain.matching} of ${plain.total}`);
    metrics.plainMatching = plain.matching;
  }
  // A copy of an empty box would match trivially: the original must exist.
  const originalBlocks = [...cells(source)].filter((position) => !isEmpty(world.blockAt(position))).length;
  if (originalBlocks === 0) {
    return { label: label ?? what, passed: false, detail: "the original's box is empty" };
  }
  return { label: label ?? what, passed: best.wrong.length === 0, detail: parts.join("; "), metrics };
}

/** A shift-only transform that puts the source box where `transform` puts it, with no mirroring or turning. */
function plainTransformOnto(source: Box, transform: CopyTransform): CopyTransform {
  const a = transform(source.min, null).target;
  const b = transform(source.max, null).target;
  const shift = {
    x: Math.min(a.x, b.x) - source.min.x,
    y: Math.min(a.y, b.y) - source.min.y,
    z: Math.min(a.z, b.z) - source.min.z,
  };
  return (position, block) => ({
    target: { x: position.x + shift.x, y: position.y + shift.y, z: position.z + shift.z },
    expected: block,
  });
}

/** The integers from `low` to `high`, inclusive. */
function range(low: number, high: number): number[] {
  return Array.from({ length: Math.max(0, high - low + 1) }, (_, index) => low + index);
}

/** Where each source cell should end up in the copy, and what the copy's block should be there. */
function copyTransform(source: Box, spec: CopySpec, anchor: BlockPosition): CopyTransform {
  const { mirror, rotate, offset } = spec;
  if (mirror !== undefined) {
    const plane = anchor[mirror.axis] + mirror.about;
    return (position, block) => {
      const mirrored = { ...position, [mirror.axis]: 2 * plane - position[mirror.axis] };
      return {
        target: { x: mirrored.x + offset[0], y: mirrored.y + offset[1], z: mirrored.z + offset[2] },
        expected: block === null ? null : mirrorState(block, mirror.axis),
      };
    };
  }
  if (rotate !== undefined) {
    const width = source.max.x - source.min.x + 1;
    const depth = source.max.z - source.min.z + 1;
    const corner = atOffset(anchor, rotate.at);
    const turns = rotate.clockwise / 90;
    return (position, block) => {
      let lx = position.x - source.min.x;
      let lz = position.z - source.min.z;
      let w = width;
      let d = depth;
      for (let turn = 0; turn < turns; turn += 1) {
        // One quarter turn clockwise seen from above (north up): north goes to east.
        [lx, lz] = [d - 1 - lz, lx];
        [w, d] = [d, w];
      }
      return {
        target: { x: corner.x + lx, y: corner.y + (position.y - source.min.y), z: corner.z + lz },
        expected: block === null ? null : rotateState(block, turns),
      };
    };
  }
  return (position, block) => ({
    target: { x: position.x + offset[0], y: position.y + offset[1], z: position.z + offset[2] },
    expected: block,
  });
}

function checkHidden(
  spec: { block: string | string[]; eye: [number, number, number]; within: number; y: [number, number] },
  label: string | undefined,
  { definition, scene, world }: CheckContext,
): CheckResult {
  const { anchor } = scene;
  const matches = nameMatcher(spec.block);
  const eye = { x: anchor.x + spec.eye[0], y: anchor.y + spec.eye[1], z: anchor.z + spec.eye[2] };
  // "Within" is measured from where the owner stands, which need not be the anchor.
  const stand = { x: Math.floor(eye.x), z: Math.floor(eye.z) };
  const near: BlockPosition[] = [];
  for (let x = stand.x - spec.within; x <= stand.x + spec.within; x += 1) {
    for (let z = stand.z - spec.within; z <= stand.z + spec.within; z += 1) {
      for (let y = anchor.y + spec.y[0]; y <= anchor.y + spec.y[1]; y += 1) {
        const block = world.blockAt({ x, y, z });
        if (block !== null && matches(block.name)) {
          near.push({ x, y, z });
        }
      }
    }
  }
  const name = describeNames(spec.block);
  const defaultLabel = `${name} within ${spec.within} blocks, hidden from your eye`;
  if (near.length === 0) {
    const elsewhere = findInSite(matches, definition, anchor, world).map((position) => where(position, anchor));
    const detail =
      elsewhere.length > 0
        ? `found only farther away or at another height: ${listSome(elsewhere)}`
        : `no ${name} found`;
    return { label: label ?? defaultLabel, passed: false, detail };
  }
  const isOccluder = (position: BlockPosition): boolean => {
    const block = world.blockAt(position);
    return block !== null && world.isOccluder(block.name);
  };
  const seen = near.flatMap((position) => {
    const point = visiblePoint(eye, position, isOccluder);
    return point === null ? [] : [`${where(position, anchor)} (visible at ${formatPoint(point)})`];
  });
  return {
    label: label ?? defaultLabel,
    passed: seen.length === 0,
    detail: seen.length === 0 ? `${near.length} found, all hidden` : `you can see ${listSome(seen)}`,
  };
}

function checkRing(
  spec: {
    block: string | string[];
    center: [number, number];
    y: [number, number];
    minRadius: number;
    maxRadius: number;
  },
  label: string | undefined,
  { definition, scene, world }: CheckContext,
): CheckResult {
  const { anchor } = scene;
  const matches = nameMatcher(spec.block);
  const center = { x: anchor.x + spec.center[0], z: anchor.z + spec.center[1] };
  const radius = definition.site.radius;
  const distance = (x: number, z: number): number => Math.hypot(x - center.x, z - center.z);
  const layers: string[] = [];
  let passed = true;
  for (let y = anchor.y + spec.y[0]; y <= anchor.y + spec.y[1]; y += 1) {
    const wallDistances: number[] = [];
    const outliers: string[] = [];
    for (let x = center.x - radius; x <= center.x + radius; x += 1) {
      for (let z = center.z - radius; z <= center.z + radius; z += 1) {
        const block = world.blockAt({ x, y, z });
        if (block !== null && matches(block.name)) {
          const d = distance(x, z);
          wallDistances.push(d);
          if (d < spec.minRadius || d > spec.maxRadius) {
            outliers.push(`${where({ x, y, z }, anchor)} at ${d.toFixed(1)}`);
          }
        }
      }
    }
    const walls = wallDistances.length;
    const ringRadius =
      walls > 0 ? wallDistances.reduce((sum, d) => sum + d, 0) / walls : (spec.minRadius + spec.maxRadius) / 2;
    const way = findWayOut(center, y, spec.maxRadius, radius, world, distance);
    // The gap is the cell on the way out that lies where the wall runs.
    const gap =
      way === null
        ? null
        : way.reduce((best, cell) =>
            Math.abs(distance(cell.x, cell.z) - ringRadius) < Math.abs(distance(best.x, best.z) - ringRadius)
              ? cell
              : best,
          );
    const problems = [
      outliers.length > 0
        ? `${outliers.length} outside ${spec.minRadius}-${spec.maxRadius} blocks: ${listSome(outliers)}`
        : "",
      gap === null ? "" : `open: you can walk out through ${where(gap, anchor)}`,
    ].filter((part) => part !== "");
    if (walls === 0 || problems.length > 0) {
      passed = false;
    }
    layers.push(
      `y=${y}: ${walls} ${describeNames(spec.block)}${problems.length > 0 ? `, ${problems.join(", ")}` : ", closed"}`,
    );
  }
  return {
    label: label ?? `closed ring of ${describeNames(spec.block)} ${spec.minRadius}-${spec.maxRadius} blocks out`,
    passed,
    detail: layers.join("; "),
  };
}

/**
 * Walks from the centre through empty cells (sideways only: nothing passes between two blocks that touch
 * at a corner) and returns a path that leads beyond the ring, from the centre outwards, or null when the
 * ring is closed.
 */
function findWayOut(
  center: { x: number; z: number },
  y: number,
  maxRadius: number,
  limit: number,
  world: CaseWorld,
  distance: (x: number, z: number) => number,
): BlockPosition[] | null {
  const start = { x: center.x, y, z: center.z };
  const parent = new Map<string, BlockPosition | null>([[keyOf(start), null]]);
  const queue: BlockPosition[] = [start];
  // Iterating the queue while pushing to it visits every cell added, in breadth-first order.
  for (const cell of queue) {
    if (distance(cell.x, cell.z) > maxRadius + 1) {
      const path: BlockPosition[] = [];
      for (let step: BlockPosition | null = cell; step !== null; step = parent.get(keyOf(step)) ?? null) {
        path.unshift(step);
      }
      return path;
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { x: cell.x + dx, y, z: cell.z + dz };
      if (Math.abs(next.x - center.x) > limit || Math.abs(next.z - center.z) > limit || parent.has(keyOf(next))) {
        continue;
      }
      if (isEmpty(world.blockAt(next))) {
        parent.set(keyOf(next), cell);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Positions in the case's site holding a matching block, nearest to the anchor first. */
function findInSite(
  matches: (name: string) => boolean,
  definition: CaseDefinition,
  anchor: BlockPosition,
  world: CaseWorld,
): BlockPosition[] {
  const { radius, height } = definition.site;
  const site = boxFromCorners(atOffset(anchor, [-radius, -1, -radius]), atOffset(anchor, [radius, height, radius]));
  const found: BlockPosition[] = [];
  for (const position of cells(site)) {
    const block = world.blockAt(position);
    if (block !== null && !isEmpty(block) && matches(block.name)) {
      found.push(position);
    }
  }
  const distance = (position: BlockPosition): number =>
    Math.abs(position.x - anchor.x) + Math.abs(position.y - anchor.y) + Math.abs(position.z - anchor.z);
  return found.sort((a, b) => distance(a) - distance(b));
}

/** The block as it looks in a mirror across a plane perpendicular to `axis`. */
function mirrorState(block: BlockState, axis: "x" | "z"): BlockState {
  const swaps: Readonly<Record<string, string>> =
    axis === "x" ? { east: "west", west: "east" } : { north: "south", south: "north" };
  const facing = block.properties.facing;
  if (facing === undefined || swaps[facing] === undefined) {
    return block;
  }
  return { name: block.name, properties: { ...block.properties, facing: swaps[facing] } };
}

/** The block turned `turns` quarter turns clockwise seen from above: its facing turns, and x and z axes swap. */
function rotateState(block: BlockState, turns: number): BlockState {
  const properties: Record<string, string> = { ...block.properties };
  const facing = CLOCKWISE.find((direction) => direction === properties.facing);
  if (facing !== undefined) {
    properties.facing = CLOCKWISE[(CLOCKWISE.indexOf(facing) + turns) % 4] ?? facing;
  }
  if (turns % 2 === 1 && (properties.axis === "x" || properties.axis === "z")) {
    properties.axis = properties.axis === "x" ? "z" : "x";
  }
  return { name: block.name, properties };
}

function isEmpty(block: BlockState | null): boolean {
  return block === null || isAir(block.name) || block.name === "snow";
}

/** True when `now` is the block that was there before the agent started, or soil where soil was. */
function untouchedGround(now: BlockState, before: BlockState | null): boolean {
  if (before === null || isEmpty(before)) {
    return false;
  }
  return now.name === before.name || (SOIL.has(now.name) && SOIL.has(before.name));
}

function* cells(box: Box): Generator<BlockPosition> {
  for (let y = box.min.y; y <= box.max.y; y += 1) {
    for (let z = box.min.z; z <= box.max.z; z += 1) {
      for (let x = box.min.x; x <= box.max.x; x += 1) {
        yield { x, y, z };
      }
    }
  }
}

function keyOf(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function describe(block: BlockState | null): string {
  if (block === null) {
    return "air";
  }
  const shown = Object.fromEntries(
    COMPARED_PROPERTIES.filter((key) => block.properties[key] !== undefined).map((key) => [
      key,
      block.properties[key] ?? "",
    ]),
  );
  return formatBlockState({ name: block.name, properties: shown });
}

function where(position: BlockPosition, anchor: BlockPosition): string {
  return `(${position.x}, ${position.y}, ${position.z}) [${offsetText([position.x - anchor.x, position.y - anchor.y, position.z - anchor.z])}]`;
}

function formatPoint(point: { x: number; y: number; z: number }): string {
  return `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
}

function offsetText(offset: readonly [number, number, number]): string {
  return offset.map((value) => (value > 0 ? `+${value}` : String(value))).join(", ");
}

function formatProps(props: Readonly<Record<string, string>>): string {
  return Object.entries(props)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function listSome(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown;
}
