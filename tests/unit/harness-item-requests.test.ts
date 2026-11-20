import { describe, expect, it } from "vitest";

import "../../src/harness/index.ts";
import type { Privileges } from "../../src/agent/privileges.ts";
import { HarnessConfigSchema } from "../../src/harness/harness.ts";
import { SkillsHarness } from "../../src/harness/skills/skills-harness.ts";
import { NullServerControl } from "../../src/minecraft/server-control/server-control.ts";
import { FakeGame } from "../fakes/fake-game.ts";

function toolNames(itemRequests: string, gameMode: Privileges["gameMode"]): string[] {
  const config = HarnessConfigSchema.parse({ harness: "skills", itemRequests });
  const harness = new SkillsHarness(config, {
    agentName: "Sol",
    owners: ["Owner"],
    privileges: { gameMode },
    server: new NullServerControl(),
    game: () => new FakeGame(),
  });
  return harness.tools().map((tool) => tool.name);
}

describe("item requests in harnesses", () => {
  it("gives survival bots request_items, automatic unless the preset asks for approval", () => {
    expect(toolNames("automatic", "survival")).toContain("request_items");
    expect(toolNames("approval", "survival")).toContain("request_items");
  });

  it("leaves it out in creative mode and when turned off", () => {
    expect(toolNames("automatic", "creative")).not.toContain("request_items");
    expect(toolNames("off", "survival")).not.toContain("request_items");
  });
});
