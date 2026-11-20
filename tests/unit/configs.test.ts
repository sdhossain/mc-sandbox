import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import "../../src/harness/index.ts";
import "../../src/llm/index.ts";
import { CaseLibrary } from "../../src/cases/case-library.ts";
import {
  ConfigPaths,
  listHarnessPresets,
  loadHarnessPreset,
  loadLabConfig,
  loadModelCatalog,
} from "../../src/config/load-config.ts";
import { HARNESS_REGISTRY } from "../../src/harness/registry.ts";
import { NullServerControl } from "../../src/minecraft/server-control/server-control.ts";

/** Every file in configs/ must load, so that a broken edit fails `npm test` instead of a live session. */
describe("configs", () => {
  it("loads the lab config, and its agents name known models and harness presets", () => {
    const lab = loadLabConfig(ConfigPaths.LAB, { MCLAB_OWNERS: "Tester" });
    const models = loadModelCatalog();
    const presets = listHarnessPresets();
    expect(lab.agents.length).toBeGreaterThan(0);
    for (const agent of lab.agents) {
      expect(models.has(agent.model), `model ${agent.model}`).toBe(true);
      expect(presets, `harness ${agent.harness}`).toContain(agent.harness);
    }
  });

  it("loads every model preset with prices", () => {
    const models = [...loadModelCatalog().values()];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.pricing.inputPerMTok, model.id).toBeGreaterThanOrEqual(0);
      expect(model.pricing.outputPerMTok, model.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("builds every harness preset's tools", () => {
    for (const preset of listHarnessPresets()) {
      const config = loadHarnessPreset(preset);
      const harness = HARNESS_REGISTRY.get(config.harness).create(config, {
        agentName: "Preview",
        owners: ["Owner"],
        privileges: { gameMode: "survival" },
        server: new NullServerControl(),
        game: () => {
          throw new Error("not connected");
        },
      });
      expect(harness.tools().length, preset).toBeGreaterThan(0);
    }
  });

  it("has a recorded start state for every case that resets an area", () => {
    const cases = CaseLibrary.load(ConfigPaths.CASES);
    for (const definition of cases.list().filter((candidate) => candidate.reset !== undefined)) {
      expect(existsSync(cases.baselinePath(definition.id)), definition.id).toBe(true);
    }
  });
});

describe("lab owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "mclab-owners-"));
  /** Writes a lab file with the given owners and one agent, and returns its path. */
  const labFile = (owners: string): string => {
    const path = join(directory, `lab-${String(owners.length)}.yaml`);
    writeFileSync(path, `owners: ${owners}\nagents:\n  - { name: Sol, model: gpt-6-luna, harness: skills }\n`);
    return path;
  };

  it("takes the owners from MCLAB_OWNERS when it is set, in place of the file's", () => {
    const path = labFile("[FileOwner]");
    expect(loadLabConfig(path, { MCLAB_OWNERS: "Alex, Sam" }).owners).toEqual(["Alex", "Sam"]);
    expect(loadLabConfig(path, {}).owners).toEqual(["FileOwner"]);
    expect(loadLabConfig(path, { MCLAB_OWNERS: " " }).owners).toEqual(["FileOwner"]);
  });

  it("says where to put a name when there is none", () => {
    expect(() => loadLabConfig(labFile("[]"), {})).toThrow(/owners: add your exact Minecraft name.*MCLAB_OWNERS/);
  });

  it("rejects a name that is not a Minecraft name, naming the variable it came from", () => {
    expect(() => loadLabConfig(labFile("[]"), { MCLAB_OWNERS: "not a name" })).toThrow(/owners from MCLAB_OWNERS/);
  });
});
