import { describe, expect, it } from "vitest";

import { TextRegionRenderer } from "../../src/minecraft/text-region-renderer.ts";
import type { BlockPosition, BlockState } from "../../src/minecraft/types.ts";

function worldOf(blocks: Record<string, BlockState>): (position: BlockPosition) => BlockState {
  return (position) => blocks[`${position.x},${position.y},${position.z}`] ?? { name: "air", properties: {} };
}

describe("TextRegionRenderer", () => {
  it("renders layers bottom first with absolute coordinates and a legend", () => {
    const renderer = new TextRegionRenderer(
      worldOf({
        "10,64,-1": { name: "stone", properties: {} },
        "11,64,0": { name: "oak_stairs", properties: { facing: "east", half: "bottom", waterlogged: "false" } },
      }),
    );
    const text = renderer.render({ min: { x: 10, y: 64, z: -1 }, max: { x: 11, y: 65, z: 0 } });

    expect(text).toContain("Legend: . air | # stone | @ oak_stairs[facing=east,half=bottom]");
    expect(text).toContain("y=65: all air");
    const layer = text.split("\n\n")[1] ?? "";
    expect(layer.split("\n")).toEqual(["y=64", "  x= 10 11", "z=-1  #  .", " z=0  .  @"]);
  });

  it("refuses boxes over the cell limit", () => {
    const renderer = new TextRegionRenderer(worldOf({}));
    expect(() => renderer.render({ min: { x: 0, y: 0, z: 0 }, max: { x: 99, y: 9, z: 99 } })).toThrow(/over the limit/);
  });
});
