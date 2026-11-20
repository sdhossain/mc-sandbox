import { describe, expect, it } from "vitest";

import { orderForBuilding, SkillLibrary } from "../../src/skills/skill-library.ts";
import { FakeGame } from "../fakes/fake-game.ts";

const quiet = { progress: () => undefined };

describe("SkillLibrary", () => {
  it("orders builds bottom-up and back and forth", () => {
    const order = orderForBuilding([
      { x: 1, y: 65, z: 0 },
      { x: 0, y: 64, z: 1 },
      { x: 1, y: 64, z: 1 },
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 64, z: 0 },
    ]);
    expect(order).toEqual([
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 64, z: 0 },
      { x: 1, y: 64, z: 1 },
      { x: 0, y: 64, z: 1 },
      { x: 1, y: 65, z: 0 },
    ]);
  });

  it("builds a floating block once its support exists, whatever the list order", async () => {
    const game = new FakeGame();
    const skills = new SkillLibrary(game, quiet);
    // (0, 66, 0) rests on (0, 65, 0), which rests on the ground at y = 63... via (0, 64, 0).
    const report = await skills.buildStructure([
      { x: 0, y: 66, z: 0, block: "stone" },
      { x: 0, y: 65, z: 0, block: "stone" },
      { x: 0, y: 64, z: 0, block: "stone" },
    ]);
    expect(report.placed).toBe(3);
    expect(report.failed).toEqual([]);
  });

  it("reports blocks that cannot be supported instead of looping", async () => {
    const game = new FakeGame();
    const report = await new SkillLibrary(game, quiet).buildStructure([{ x: 0, y: 80, z: 0, block: "stone" }]);
    expect(report.placed).toBe(0);
    expect(report.failed[0]?.reason).toBe("nothing to place it against");
  });

  it("counts blocks that are already correct", async () => {
    const game = new FakeGame();
    const skills = new SkillLibrary(game, quiet);
    await skills.fillRegion({ min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 64, z: 2 } }, "oak_planks");
    const again = await skills.fillRegion({ min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 64, z: 2 } }, "oak_planks");
    expect(again.alreadyCorrect).toBe(9);
    expect(again.placed).toBe(0);
  });

  it("tills, waters and plants a farm plot", async () => {
    const game = new FakeGame();
    const report = await new SkillLibrary(game, quiet).farmPlot(
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      63,
      "wheat_seeds",
      true,
    );
    expect(report.water).toEqual({ x: 1, y: 63, z: 1 });
    expect(report.tilled).toBe(8);
    expect(report.planted).toBe(8);
    expect(game.world.get({ x: 0, y: 64, z: 0 }).name).toBe("wheat");
  });

  it("gathers dirt from grass blocks with an open top, never from under the grass or under itself", async () => {
    const game = new FakeGame();
    game.position = { x: 0, y: 64, z: 0 };
    game.world.blocks.set("0,63,0", { name: "grass_block", properties: {} }); // under the bot's feet
    game.world.blocks.set("3,63,0", { name: "grass_block", properties: {} }); // open on top
    game.world.blocks.set("3,62,0", { name: "dirt", properties: {} }); // buried under that grass
    const report = await new SkillLibrary(game, quiet).collectBlocks("dirt", 5);
    expect(report.sources).toContain("grass_block");
    expect(game.world.get({ x: 3, y: 63, z: 0 }).name).toBe("air");
    expect(game.world.get({ x: 0, y: 63, z: 0 }).name).toBe("grass_block");
    // Once the grass is gone the dirt below is open on top, but it lies below the bot's ground level and
    // the fake world never yields items, so the skill stops instead of digging on.
    expect(report.blocksDug).toBeLessThanOrEqual(2);
  });

  it("stops after three digs in a row that pick nothing up", async () => {
    const game = new FakeGame();
    game.position = { x: 0, y: 64, z: 0 };
    for (const x of [2, 3, 4, 5, 6, 7]) {
      game.world.blocks.set(`${x},63,0`, { name: "grass_block", properties: {} });
    }
    const report = await new SkillLibrary(game, quiet).collectBlocks("dirt", 5);
    expect(report.blocksDug).toBe(3);
    expect(report.stoppedBecause).toMatch(/three digs in a row picked nothing up/);
  });

  it("refuses items no block drops", async () => {
    await expect(new SkillLibrary(new FakeGame(), quiet).collectBlocks("iron_ingot", 1)).rejects.toThrow(
      /No block drops iron_ingot/,
    );
  });

  it("rejects unknown block names with suggestions", async () => {
    const game = new FakeGame();
    await expect(
      new SkillLibrary(game, quiet).buildStructure([{ x: 0, y: 64, z: 0, block: "wood_planks" }]),
    ).rejects.toThrow(/Unknown item "wood_planks". Did you mean/);
  });
});
