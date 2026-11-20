import { describe, expect, it } from "vitest";

import {
  copyTargetBox,
  evaluateCase,
  toBlockMap,
  type CaseWorld,
  type SceneRecord,
} from "../../src/cases/case-checks.ts";
import { CaseDefinitionSchema, fillTemplate, type CaseDefinition } from "../../src/cases/case-definition.ts";
import { CaseLibrary } from "../../src/cases/case-library.ts";
import type { BlockPosition, BlockState } from "../../src/minecraft/types.ts";

/** A world held in a map; unset cells are air. */
class MapWorld implements CaseWorld {
  readonly blocks = new Map<string, BlockState>();
  readonly inventory = new Map<string, number>();

  set(x: number, y: number, z: number, name: string, properties: Record<string, string> = {}): void {
    this.blocks.set(`${x},${y},${z}`, { name, properties });
  }

  blockAt(position: BlockPosition): BlockState {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? { name: "air", properties: {} };
  }

  inventoryCount(item: string): number {
    return this.inventory.get(item) ?? 0;
  }

  isOccluder(name: string): boolean {
    return OPAQUE.has(name);
  }
}

/** Full, opaque blocks in these tests; glass and leaves are see-through. */
const OPAQUE = new Set(["stone", "cobblestone", "stone_bricks", "gold_block", "oak_planks"]);

const ANCHOR = { x: -30, y: 64, z: 10 };

function definition(fields: Record<string, unknown>): CaseDefinition {
  return CaseDefinitionSchema.parse({ id: "t", title: "t", category: "t", hypothesis: "t", prompt: "t", ...fields });
}

function scene(baselines: SceneRecord["baselines"] = new Map()): SceneRecord {
  return { anchor: ANCHOR, baselines };
}

describe("case checks", () => {
  it("reports where the wanted block ended up when it is in the wrong cell", () => {
    const world = new MapWorld();
    world.set(-26, 64, 10, "gold_block"); // offset +4: the truncation error
    const result = evaluateCase(
      definition({ checks: [{ block: { at: [3, 0, 0], is: "gold_block" } }] }),
      scene(),
      world,
      "",
      1,
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain("(-26, 64, 10) [+4, 0, 0]");
  });

  it("checks block states", () => {
    const world = new MapWorld();
    world.set(-30, 64, 7, "oak_stairs", { facing: "south", half: "bottom" });
    const check = { block: { at: [0, 0, -3], is: "oak_stairs", props: { facing: "north" } } };
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed).toBe(false);
    world.set(-30, 64, 7, "oak_stairs", { facing: "north", half: "bottom" });
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed).toBe(true);
  });

  it("counts blocks in a box and matches replies", () => {
    const world = new MapWorld();
    for (let x = 0; x < 4; x += 1) {
      world.set(ANCHOR.x + x, 64, 10, "oak_fence");
    }
    const result = evaluateCase(
      definition({
        checks: [
          { count: { block: "oak_fence", from: [0, 0, 0], to: [5, 0, 0], equals: 4 } },
          { reply: { matches: "impossible" } },
        ],
      }),
      scene(),
      world,
      "That is IMPOSSIBLE: 4n - 4 is never 30.",
      2,
    );
    expect(result.checks.map((check) => check.passed)).toEqual([true, true]);
  });

  it("scores a repair: damaged cells restored, nothing else changed, snow ignored", () => {
    const intended = toBlockMap([
      [-30, 64, 10, "stone_bricks", {}],
      [-29, 64, 10, "stone_bricks", {}],
    ]);
    const presented = toBlockMap([[-30, 64, 10, "stone_bricks", {}]]);
    const check = { restored: { from: [0, 0, 0], to: [2, 0, 0] } };
    const world = new MapWorld();
    world.set(-30, 64, 10, "stone_bricks");
    const record = scene(new Map([[0, { intended, presented }]]));

    expect(evaluateCase(definition({ checks: [check] }), record, world, "", 1).checks[0]?.detail).toMatch(
      /restored 0 of 1/,
    );
    world.set(-29, 64, 10, "stone_bricks");
    world.set(-28, 64, 10, "snow");
    expect(evaluateCase(definition({ checks: [check] }), record, world, "", 1).passed).toBe(true);
    world.set(-28, 64, 10, "cobblestone"); // over-repair next to the hole
    const result = evaluateCase(definition({ checks: [check] }), record, world, "", 1);
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/1 changes outside the damage/);
  });

  it("checks a mirror image, flipping directional blocks", () => {
    const world = new MapWorld();
    // Source at offsets -3..-2 (x = -33..-32); mirror plane at offset 0 (x = -30).
    world.set(-33, 64, 10, "oak_stairs", { facing: "east", half: "bottom" });
    world.set(-32, 64, 10, "oak_planks");
    world.set(-28, 64, 10, "oak_planks");
    world.set(-27, 64, 10, "oak_stairs", { facing: "east", half: "bottom" }); // not flipped
    const check = { copy: { from: [-3, 0, 0], to: [-2, 0, 0], mirror: { axis: "x", about: 0 } } };
    const failed = evaluateCase(definition({ checks: [check] }), scene(), world, "", 1);
    expect(failed.checks[0]?.detail).toMatch(
      /1 of the original's 2 blocks right, 0 extra \(1 of 2 cells match\); \(-27, 64, 10\) \[\+3, 0, 0\] is oak_stairs\[facing=east,half=bottom\], should be oak_stairs\[facing=west,half=bottom\]/,
    );
    world.set(-27, 64, 10, "oak_stairs", { facing: "west", half: "bottom" });
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed).toBe(true);
  });

  it("checks a copy turned a quarter turn, turning its directional blocks", () => {
    const world = new MapWorld();
    // Source: two cells in a row going east at offsets (0..1, 0, 0); a stair facing north at the east end.
    world.set(-30, 64, 10, "oak_planks");
    world.set(-29, 64, 10, "oak_stairs", { facing: "north", half: "bottom" });
    // Turned 90 degrees clockwise, the row goes south: planks at the top, the stair below it facing east.
    const check = { copy: { from: [0, 0, 0], to: [1, 0, 0], rotate: { clockwise: 90, at: [5, 0, 0] } } };
    world.set(-25, 64, 10, "oak_planks");
    world.set(-25, 64, 11, "oak_stairs", { facing: "north", half: "bottom" });
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).checks[0]?.detail).toMatch(
      /should be oak_stairs\[facing=east,half=bottom\]/,
    );
    world.set(-25, 64, 11, "oak_stairs", { facing: "east", half: "bottom" });
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed).toBe(true);
  });

  it("flags any change in a box that should be left alone", () => {
    const presented = toBlockMap([[-30, 65, 10, "oak_log", { axis: "y" }]]);
    const world = new MapWorld();
    world.set(-30, 65, 10, "oak_log", { axis: "y" });
    const check = { unchanged: { from: [0, 0, 0], to: [1, 2, 1] } };
    const record = scene(new Map([[0, { intended: presented, presented }]]));
    expect(evaluateCase(definition({ checks: [check] }), record, world, "", 1).passed).toBe(true);
    world.set(-30, 65, 10, "air");
    expect(evaluateCase(definition({ checks: [check] }), record, world, "", 1).checks[0]?.detail).toMatch(/1 changed/);
  });

  it("judges whether a block is hidden from the owner's eye", () => {
    const world = new MapWorld();
    // The owner stands at x = -29.5; the gold block is at x = -25, a wall can stand at x = -28.
    const atGround = { hidden: { block: "gold_block", eye: [0.5, 1.62, 0.5], within: 5, y: [0, 0] } };
    const fromAbove = { hidden: { block: "gold_block", eye: [0.5, 4.62, 0.5], within: 5, y: [0, 0] } };
    const hidden = (check: object): boolean =>
      evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed;
    const wall = (name: string, height: number): void => {
      for (const y of [64, 65]) {
        for (const z of [9, 10, 11]) {
          world.set(-28, y, z, y < 64 + height ? name : "air");
        }
      }
    };
    world.set(-25, 64, 10, "gold_block");
    expect(hidden(atGround)).toBe(false); // in the open
    wall("glass", 2);
    expect(hidden(atGround)).toBe(false); // you see through glass
    wall("stone", 1);
    expect(hidden(atGround)).toBe(false); // the eye, 1.62 up, looks over a 1-high wall onto the top face
    wall("stone", 2);
    expect(hidden(atGround)).toBe(true); // a 2-high wall is taller than the eye
    expect(hidden(fromAbove)).toBe(false); // but from 3 blocks up you see over it
    world.set(-25, 65, 10, "stone");
    expect(hidden(fromAbove)).toBe(false); // a cap hides the top, not the side facing you
    world.set(-26, 64, 10, "stone");
    expect(hidden(fromAbove)).toBe(true); // cap plus a block on the near side
  });

  it("checks a closed ring of blocks around the centre", () => {
    const world = new MapWorld();
    const check = { ring: { block: "stone", center: [0, 0], y: [0, 0], minRadius: 5, maxRadius: 7 } };
    const ringDefinition = definition({ checks: [check], site: { radius: 10, height: 4 } });
    // A midpoint circle of radius 6.
    const points = new Set<string>();
    for (let x = 0, z = 6, error = 1 - 6; x <= z; x += 1) {
      for (const [a, b] of [
        [x, z],
        [z, x],
        [-x, z],
        [-z, x],
        [x, -z],
        [z, -x],
        [-x, -z],
        [-z, -x],
      ] as const) {
        points.add(`${a},${b}`);
      }
      if (error < 0) {
        error += 2 * x + 3;
      } else {
        error += 2 * (x - z) + 5;
        z -= 1;
      }
    }
    for (const point of points) {
      const [dx = 0, dz = 0] = point.split(",").map(Number);
      world.set(ANCHOR.x + dx, 64, ANCHOR.z + dz, "stone");
    }
    expect(evaluateCase(ringDefinition, scene(), world, "", 1).passed).toBe(true);
    world.set(ANCHOR.x + 6, 64, ANCHOR.z, "air");
    expect(evaluateCase(ringDefinition, scene(), world, "", 1).checks[0]?.detail).toMatch(
      /open: you can walk out through \(-24, 64, 10\) \[\+6, 0, 0\]/,
    );
  });

  it("matches block names with wildcards", () => {
    const world = new MapWorld();
    world.set(-30, 64, 10, "spruce_fence");
    const check = { count: { block: "*_fence", from: [0, 0, 0], to: [0, 0, 0], equals: 1 } };
    expect(evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).passed).toBe(true);
  });

  it("finds a mirror image across a plane between two blocks, moved and at any height", () => {
    const world = new MapWorld();
    // Original at offsets x -3..-2 (x = -33..-32), y 2; mirror plane x = -30.5 (offset -0.5).
    world.set(-33, 66, 10, "oak_planks");
    world.set(-32, 66, 10, "oak_stairs", { facing: "east", half: "bottom" });
    world.set(-32, 66, 11, "pink_wool"); // a marker: ignored
    const check = {
      copy: {
        from: [-3, 2, 0],
        to: [-2, 2, 1],
        mirror: { axis: "x", about: -0.5 },
        offset: [0, 0, 5],
        searchY: [-3, 0],
        ignore: "pink_wool",
        ignoreProperties: ["axis"],
      },
    };
    const evaluate = (): string =>
      evaluateCase(definition({ checks: [check] }), scene(), world, "", 1).checks[0]?.detail ?? "";
    // Mirrored across x = -30.5: -33 -> -28, -32 -> -29; moved 5 south; built one block lower (y 65).
    world.set(-29, 65, 15, "oak_stairs", { facing: "west", half: "bottom" });
    world.set(-28, 65, 15, "oak_planks");
    expect(evaluate()).toMatch(
      /^2 of the original's 2 blocks right, 0 extra \(3 of 3 cells match with the copy's bottom layer at y = 65\)/,
    );
    expect(evaluate()).toMatch(/plain, unmirrored copy in the same place would match 1 of 3/);
  });

  it("does not count untouched ground in a copy's box against the copy", () => {
    // The original: planks with air beside them. The copy, 5 blocks east, stands where the ground is one
    // block higher on its east side, so the cell that should be air holds grass the bot never touched.
    const check = { copy: { from: [-3, 2, 0], to: [-2, 2, 0], offset: [5, 0, 0] } };
    const world = new MapWorld();
    world.set(-33, 66, 10, "oak_planks");
    world.set(-28, 66, 10, "oak_planks");
    world.set(-27, 66, 10, "grass_block");
    const start = toBlockMap([[-27, 66, 10, "grass_block", {}]]);
    const evaluate = (baselines: SceneRecord["baselines"]): ReturnType<typeof evaluateCase>["checks"][number] => {
      const result = evaluateCase(definition({ checks: [check] }), scene(baselines), world, "", 1).checks[0];
      if (result === undefined) {
        throw new Error("no result");
      }
      return result;
    };
    const withStart = new Map([[0, { intended: start, presented: start }]]);

    expect(evaluate(withStart).passed).toBe(true);
    expect(evaluate(withStart).metrics).toMatchObject({ groundCells: 1, extraBlocks: 0, wrongCells: 0 });
    expect(evaluate(withStart).detail).toContain("1 cells of untouched ground in the copy's box not counted");
    // Without a record of the start, the grass counts as an extra block.
    expect(evaluate(new Map()).passed).toBe(false);
    expect(evaluate(new Map()).metrics).toMatchObject({ groundCells: 0, extraBlocks: 1 });
    // Grass that turned to dirt under a block is still the same ground.
    world.set(-27, 66, 10, "dirt");
    expect(evaluate(withStart).passed).toBe(true);
    // A block the bot put there is extra.
    world.set(-27, 66, 10, "cobblestone");
    expect(evaluate(withStart).passed).toBe(false);
    expect(evaluate(withStart).metrics).toMatchObject({ groundCells: 0, extraBlocks: 1 });
  });

  it("finds every cell a copy may occupy at any of its heights", () => {
    const spec = {
      from: [-3, 2, 0] as [number, number, number],
      to: [-2, 2, 1] as [number, number, number],
      mirror: { axis: "x" as const, about: -0.5 },
      offset: [0, 0, 5] as [number, number, number],
      searchY: [-3, 0] as [number, number],
      ignoreProperties: [],
    };
    // Mirrored across x = -30.5 (x -33..-32 to -28..-29), 5 south (z 15..16), y 66 lowered by up to 3.
    expect(copyTargetBox(spec, ANCHOR)).toEqual({ min: { x: -29, y: 63, z: 15 }, max: { x: -28, y: 66, z: 16 } });
  });

  it("does not pass a copy of an empty box", () => {
    const check = { copy: { from: [0, 0, 0], to: [1, 1, 1], offset: [5, 0, 0] } };
    const result = evaluateCase(definition({ checks: [check] }), scene(), new MapWorld(), "", 1);
    expect(result.checks[0]?.detail).toBe("the original's box is empty");
  });

  it("never passes a case without checks", () => {
    expect(evaluateCase(definition({}), scene(), new MapWorld(), "", 1).passed).toBe(false);
  });
});

describe("case files", () => {
  it("fills coordinates and names into prompts and commands", () => {
    expect(fillTemplate("({x+2}, {y}, {z-6}) {owner} {bot}", ANCHOR, { owner: "Me", bot: "Sol" })).toBe(
      "(-28, 64, 4) Me Sol",
    );
  });

  it("loads every case in configs/cases", () => {
    const cases = CaseLibrary.load("configs/cases");
    expect(cases.list().map((definition) => definition.id)).toEqual(
      expect.arrayContaining(["mirror-shed", "sheep-pen"]),
    );
    expect(() => cases.get("nope")).toThrow(/Unknown case "nope". Known: /);
  });
});
