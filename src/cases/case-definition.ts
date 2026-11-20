/**
 * The format of a failure case: a reproducible scene, a task, and automatic checks.
 *
 * Case files live in `configs/cases/<id>.yaml`. Every coordinate is relative to the case's anchor:
 * the block the owner stands in when the case starts (x east, y up, z south). In setup commands, `~`
 * is relative to the anchor as well, because the runner executes them positioned there.
 */

import { z } from "zod";

import { boxFromCorners, type BlockPosition, type Box } from "../minecraft/types.ts";
import { GameMode } from "../utils/names.ts";

/** A block offset from the anchor, `[dx, dy, dz]`. */
const OffsetSchema = z.tuple([z.int(), z.int(), z.int()]);
/** A position offset from the anchor that may be fractional, for placing players. */
const PlayerOffsetSchema = z.tuple([z.number(), z.number(), z.number()]);
/** One block name, or several accepted names. `*` matches any characters: `*_fence`, or `*` for any block. */
const BlockNamesSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const HorizontalDirectionSchema = z.enum(["north", "south", "east", "west"]);

/** The cell at an offset holds one of the given blocks, optionally with these block-state values. */
const BlockCheckSchema = z.strictObject({
  label: z.string().optional(),
  block: z.strictObject({
    at: OffsetSchema,
    is: BlockNamesSchema,
    props: z.record(z.string(), z.string()).optional(),
  }),
});

/** The number of cells holding the given blocks in a box is in range. */
const CountCheckSchema = z.strictObject({
  label: z.string().optional(),
  count: z
    .strictObject({
      block: BlockNamesSchema,
      from: OffsetSchema,
      to: OffsetSchema,
      equals: z.int().nonnegative().optional(),
      min: z.int().nonnegative().optional(),
      max: z.int().nonnegative().optional(),
    })
    .refine((count) => count.equals !== undefined || count.min !== undefined || count.max !== undefined, {
      message: "a count check needs equals, min or max",
    }),
});

/** The bot holds at least `min` of an item. */
const InventoryCheckSchema = z.strictObject({
  label: z.string().optional(),
  inventory: z.strictObject({ item: z.string(), min: z.int().positive().default(1) }),
});

/** The agent's final reply of the turn matches a regular expression (case-insensitive). */
const ReplyCheckSchema = z.strictObject({
  label: z.string().optional(),
  reply: z.strictObject({ matches: z.string() }),
});

/**
 * Every cell in the box that the damage commands changed is back to its state after setup, and no
 * other cell in the box was changed.
 */
const RestoredCheckSchema = z.strictObject({
  label: z.string().optional(),
  restored: z.strictObject({ from: OffsetSchema, to: OffsetSchema }),
});

/** No cell in the box differs from the scene as it was presented to the agent. */
const UnchangedCheckSchema = z.strictObject({
  label: z.string().optional(),
  unchanged: z.strictObject({ from: OffsetSchema, to: OffsetSchema }),
});

/**
 * Every cell of the source box is reproduced elsewhere, with directional blocks transformed too:
 * shifted by `offset`; or mirrored across the plane `axis = about` (anchor-relative), so east-facing
 * stairs become west-facing; or turned `clockwise` degrees seen from above, with the turned box's
 * north-west bottom corner at `to`, so north-facing stairs become east-facing after 90 degrees.
 */
const CopyCheckSchema = z.strictObject({
  label: z.string().optional(),
  copy: z
    .strictObject({
      from: OffsetSchema,
      to: OffsetSchema,
      /** Applied after mirroring, so a mirror image can also be moved to a marked area. */
      offset: OffsetSchema.default([0, 0, 0]),
      /** `about` may be a half: x = -10.5 is the plane between two blocks. */
      mirror: z.strictObject({ axis: z.enum(["x", "z"]), about: z.number().multipleOf(0.5) }).optional(),
      rotate: z
        .strictObject({ clockwise: z.union([z.literal(90), z.literal(180), z.literal(270)]), at: OffsetSchema })
        .optional(),
      /** Try every vertical offset in this range instead of `offset[1]`, and keep the best match. */
      searchY: z.tuple([z.int(), z.int()]).optional(),
      /** Skip cells where the original or the copy holds one of these blocks (markers, for example). */
      ignore: BlockNamesSchema.optional(),
      /** Block-state keys not compared, such as wood `axis`, which the bot cannot choose. */
      ignoreProperties: z.array(z.string()).default([]),
    })
    .refine((copy) => copy.mirror === undefined || copy.rotate === undefined, {
      message: "a copy check mirrors or rotates, not both",
    }),
});

/**
 * No part of any matching block within `within` blocks (horizontally) of the owner can be seen from the
 * eye point: every line from the eye to the block passes through a full, opaque block first. At least
 * one matching block must be there.
 */
const HiddenCheckSchema = z.strictObject({
  label: z.string().optional(),
  hidden: z.strictObject({
    block: BlockNamesSchema,
    /** The owner's eye, relative to the anchor: their position plus 1.62 up. */
    eye: PlayerOffsetSchema,
    within: z.int().positive(),
    /** The heights (anchor-relative) the block may be at. */
    y: z.tuple([z.int(), z.int()]),
  }),
});

/**
 * At each height in `y`, the given blocks form a closed ring around `center`: every such block lies
 * between `minRadius` and `maxRadius` from the centre, and nothing can walk from the centre to beyond
 * the ring without passing through a block.
 */
const RingCheckSchema = z.strictObject({
  label: z.string().optional(),
  ring: z.strictObject({
    block: BlockNamesSchema,
    center: z.tuple([z.int(), z.int()]),
    y: z.tuple([z.int(), z.int()]),
    minRadius: z.number().nonnegative(),
    maxRadius: z.number().positive(),
  }),
});

/** One automatic check, evaluated when each turn of the case ends. */
export const CaseCheckSchema = z.union([
  BlockCheckSchema,
  CountCheckSchema,
  InventoryCheckSchema,
  ReplyCheckSchema,
  RestoredCheckSchema,
  UnchangedCheckSchema,
  CopyCheckSchema,
  HiddenCheckSchema,
  RingCheckSchema,
]);
export type CaseCheck = z.infer<typeof CaseCheckSchema>;

/** A failure case file. */
export const CaseDefinitionSchema = z.strictObject({
  /** Matches the file name; what the owner types after `!case`. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** The kind of failure probed, for grouping, for example `coordinates` or `perception`. */
  category: z.string(),
  /** What the case expects models to get wrong, and why. */
  hypothesis: z.string(),
  /** The game mode the agent must have. `any` runs in both. */
  gameMode: z.enum([GameMode.CREATIVE, GameMode.SURVIVAL, "any"]).default("any"),
  /**
   * `flatten` (the default) replaces the site with flat ground and builds the scene with `setup`;
   * `existing` uses the world as it is and changes nothing but where the players stand.
   */
  scene: z.enum(["flatten", "existing"]).default("flatten"),
  /**
   * A fixed world position (x, y, z) that the case's coordinates are relative to, for cases set in a
   * particular place. Without it, the anchor is the block the owner stands in when the case starts.
   */
  anchor: z.tuple([z.int(), z.int(), z.int()]).optional(),
  /**
   * A box (anchor-relative) put back to its recorded state before every run, so each run starts from the
   * same world. The state is `configs/cases/<id>.baseline.json.gz`, captured from a checkpoint with
   * `npm run lab -- cases baseline <id> --from <checkpoint id>`.
   */
  reset: z.strictObject({ from: OffsetSchema, to: OffsetSchema }).optional(),
  /** Conditions on the anchor, for cases that only probe something at certain coordinates. */
  requires: z.strictObject({ negativeX: z.boolean().default(false) }).default({ negativeX: false }),
  /**
   * The area the runner replaces with flat ground before setup: `radius` blocks around the anchor
   * horizontally, `height` blocks of air above the ground.
   */
  site: z
    .strictObject({ radius: z.int().min(2).max(24).default(8), height: z.int().min(2).max(40).default(8) })
    .default({ radius: 8, height: 8 }),
  /** Where the owner is put, relative to the anchor, and which way they face; null leaves them where they are. */
  owner: z
    .strictObject({ at: PlayerOffsetSchema.default([0.5, 0, 0.5]), facing: HorizontalDirectionSchema.default("north") })
    .nullable()
    .default({ at: [0.5, 0, 0.5], facing: "north" }),
  /** Where the bot is put, relative to the anchor. */
  bot: z.strictObject({ at: PlayerOffsetSchema.default([-2.5, 0, 3.5]) }).default({ at: [-2.5, 0, 3.5] }),
  /** Server commands that build the scene, without a leading slash. `{owner}` and `{bot}` are replaced. */
  setup: z.array(z.string()).default([]),
  /** Commands run after the scene is recorded as correct, to damage it (for `restored` checks). */
  damage: z.array(z.string()).default([]),
  /** The task, sent as if the owner typed it. `{x}`, `{y+2}`, `{z-6}` become anchor coordinates. */
  prompt: z.string(),
  checks: z.array(CaseCheckSchema).default([]),
  /** What to look for in the transcript and on the dashboard. */
  watch: z.array(z.string()).default([]),
  /** Anything else the person running the case should know, for example a step they must do by hand. */
  notes: z.string().default(""),
});
export type CaseDefinition = z.infer<typeof CaseDefinitionSchema>;

/** Command yaw, in degrees, for each horizontal direction (vanilla: south 0, west 90, north 180). */
export const COMMAND_YAW: Readonly<Record<z.infer<typeof HorizontalDirectionSchema>, number>> = {
  south: 0,
  west: 90,
  north: 180,
  east: -90,
};

/** Layers of ground a flattened site gets below the anchor: grass on top of dirt. */
export const SITE_GROUND_DEPTH = 4;

/**
 * The box a case works in, in absolute coordinates: its `reset` box, or else everything flattening
 * its site replaces, ground included.
 */
export function caseAreaBox(definition: CaseDefinition, anchor: BlockPosition): Box {
  if (definition.reset !== undefined) {
    return boxFromCorners(atOffset(anchor, definition.reset.from), atOffset(anchor, definition.reset.to));
  }
  const { radius, height } = definition.site;
  return boxFromCorners(
    atOffset(anchor, [-radius, -SITE_GROUND_DEPTH, -radius]),
    atOffset(anchor, [radius, height, radius]),
  );
}

/** The absolute position of an offset from the anchor. */
export function atOffset(anchor: BlockPosition, offset: readonly [number, number, number]): BlockPosition {
  return { x: anchor.x + offset[0], y: anchor.y + offset[1], z: anchor.z + offset[2] };
}

/** Tests block names against one name or several, where `*` matches any characters. */
export function nameMatcher(names: string | readonly string[]): (name: string) => boolean {
  const list = typeof names === "string" ? [names] : names;
  const patterns = list.map(
    (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
  );
  return (name) => patterns.some((pattern) => pattern.test(name));
}

/** The given block names as one readable string. */
export function describeNames(names: string | readonly string[]): string {
  return typeof names === "string" ? names : names.join(" or ");
}

/**
 * Replaces placeholders in a prompt or command: `{x}`, `{y}`, `{z}` with an optional `+n` or `-n` become
 * anchor coordinates, and `{owner}` and `{bot}` become player names.
 */
export function fillTemplate(
  text: string,
  anchor: BlockPosition,
  names: { readonly owner: string; readonly bot: string },
): string {
  return text
    .replace(/\{([xyz])([+-]\d+)?\}/g, (_, axis: "x" | "y" | "z", delta: string | undefined) =>
      String(anchor[axis] + Number(delta ?? 0)),
    )
    .replace(/\{owner\}/g, names.owner)
    .replace(/\{bot\}/g, names.bot);
}
