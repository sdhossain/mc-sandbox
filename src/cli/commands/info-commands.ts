import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atOffset, type CaseDefinition } from "../../cases/case-definition.ts";
import { CaseLibrary } from "../../cases/case-library.ts";
import { CaseTemplate, scaffoldCase } from "../../cases/case-scaffold.ts";
import type { LabConfig } from "../../config/lab-config.ts";
import { connectServerControl, worldDirectoryOf } from "../../lab/lab.ts";
import { AnvilReader } from "../../mcserver/anvil-reader.ts";
import { captureBaseline, readBaseline, writeBaseline } from "../../mcserver/region-baseline.ts";
import { LiveRegions } from "../../mcserver/live-regions.ts";
import { boxFromCorners, type Box } from "../../minecraft/types.ts";
import { LabError } from "../../utils/errors.ts";
import {
  ConfigPaths,
  listHarnessPresets,
  loadHarnessPreset,
  loadLabConfig,
  loadModelCatalog,
} from "../../config/load-config.ts";
import { HARNESS_REGISTRY } from "../../harness/registry.ts";
import { NullServerControl } from "../../minecraft/server-control/server-control.ts";
import { formatDuration, formatUsd } from "../../utils/text.ts";
import { booleanFlag, Command, stringFlag, type Flags } from "../command.ts";

/** `mclab models`: lists the model presets with prices. */
export class ModelsCommand extends Command {
  readonly name = "models";
  readonly summary = "List model presets from configs/models.yaml";
  readonly usage = "Usage: mclab models";
  protected readonly options = {} as const;

  protected execute(): Promise<number> {
    for (const model of loadModelCatalog().values()) {
      const price = `$${model.pricing.inputPerMTok}/$${model.pricing.outputPerMTok} per M in/out`;
      console.log(`${model.id.padEnd(20)} ${model.provider.padEnd(12)} ${price.padEnd(28)} ${model.description}`);
    }
    return Promise.resolve(0);
  }
}

/** `mclab cases`: lists the failure cases, or describes one. */
export class CasesCommand extends Command {
  readonly name = "cases";
  readonly summary = "List, describe or create failure cases; record or restore the area a case resets";
  readonly usage = `Usage: mclab cases [id]
       mclab cases new <id> [--existing]                  write configs/cases/<id>.yaml from a template: a scene
                                                          on generated ground, or (--existing) in your world
       mclab cases baseline <id> --from <checkpoint id>   record the case's reset area from a checkpoint
       mclab cases reset <id>                             put the area back now (the server must be running)

Every case file is checked when the cases are loaded, so "mclab cases" also validates them all.
How to write a case: docs/cases.md`;
  protected readonly options = {
    config: { type: "string" },
    from: { type: "string" },
    existing: { type: "boolean" },
  } as const;

  protected async execute(flags: Flags, positionals: readonly string[]): Promise<number> {
    const [first, second] = positionals;
    if (first === "new") {
      return this.#create(second, booleanFlag(flags, "existing"));
    }
    const library = CaseLibrary.load(ConfigPaths.CASES);
    if (first === "baseline" || first === "reset") {
      if (second === undefined) {
        throw new LabError(`Which case? ${this.usage}`);
      }
      const config = loadLabConfig(stringFlag(flags, "config"));
      return first === "baseline"
        ? this.#captureBaseline(library, second, config, stringFlag(flags, "from"))
        : this.#resetArea(library, second, config);
    }
    const id = first;
    if (id === undefined) {
      for (const definition of library.list()) {
        const mode = definition.gameMode === "any" ? "" : ` (${definition.gameMode})`;
        console.log(`${definition.id.padEnd(18)} ${definition.category.padEnd(24)} ${definition.title}${mode}`);
      }
      console.log("\nRun one in game: !case <id>. Details: npm run lab -- cases <id>");
      return Promise.resolve(0);
    }
    const definition = library.get(id);
    console.log(`${definition.id}: ${definition.title} [${definition.category}, ${definition.gameMode} mode]\n`);
    console.log(`Hypothesis: ${definition.hypothesis.trim()}\n`);
    console.log(`Task: ${definition.prompt}\n`);
    const checks = definition.checks.map(
      (check) => `  - ${check.label ?? Object.keys(check).find((key) => key !== "label")}`,
    );
    console.log(`Automatic checks:\n${checks.join("\n") || "  (none: judge from the transcript)"}\n`);
    if (definition.watch.length > 0) {
      console.log(`Watch for:\n${definition.watch.map((line) => `  - ${line}`).join("\n")}\n`);
    }
    if (definition.notes !== "") {
      console.log(`Notes: ${definition.notes.trim()}`);
    }
    return Promise.resolve(0);
  }

  #create(id: string | undefined, existing: boolean): Promise<number> {
    if (id === undefined) {
      throw new LabError(`Which id? ${this.usage}`);
    }
    const path = scaffoldCase(ConfigPaths.CASES, id, existing ? CaseTemplate.EXISTING : CaseTemplate.FLATTEN);
    // The new file must load like any other case.
    CaseLibrary.load(ConfigPaths.CASES).get(id);
    const steps = existing
      ? [
          "Build the scene on the lab's server; set anchor (the block you stand in, from F3) and the reset box.",
          "Save a checkpoint (!save in chat), then record the start state:",
          `  npm run lab -- cases baseline ${id} --from <checkpoint id>`,
        ]
      : ["Edit the setup commands, the prompt and the checks."];
    console.log(
      [
        `Wrote ${path}.`,
        ...steps,
        `Check it: npm run lab -- cases ${id}`,
        `Try it in game: !case ${id}`,
        "Guide: docs/cases.md",
      ].join("\n"),
    );
    return Promise.resolve(0);
  }

  #captureBaseline(
    library: CaseLibrary,
    id: string,
    config: LabConfig,
    checkpointId: string | undefined,
  ): Promise<number> {
    if (checkpointId === undefined) {
      throw new LabError(
        "Capture from which checkpoint? Add --from <checkpoint id> (see: npm run lab -- checkpoint list).",
      );
    }
    const box = resetBoxOf(library.get(id));
    const reader = new AnvilReader(join(config.checkpoints.dir, checkpointId, "world"));
    const baseline = captureBaseline(box, (position) => reader.blockAt(position), `checkpoint ${checkpointId}`);
    const path = library.baselinePath(id);
    writeBaseline(path, baseline);
    console.log(
      `Recorded ${baseline.cells.length} cells (${baseline.palette.length} block states) from checkpoint ${checkpointId} to ${path}.`,
    );
    return Promise.resolve(0);
  }

  async #resetArea(library: CaseLibrary, id: string, config: LabConfig): Promise<number> {
    const box = resetBoxOf(library.get(id));
    const baseline = readBaseline(library.baselinePath(id));
    if (JSON.stringify(baseline.box) !== JSON.stringify(box)) {
      throw new LabError(`The recorded baseline covers a different box than the case; record it again.`);
    }
    const server = await connectServerControl(config);
    try {
      const report = await new LiveRegions(server, worldDirectoryOf(config)).restore(baseline);
      console.log(
        `Reset case ${id}'s area from ${baseline.source}: ${report.commands} commands in ${formatDuration(report.durationMs)}.`,
      );
    } finally {
      await server.close();
    }
    return 0;
  }
}

/** The absolute box a case resets; only cases with a fixed anchor and a `reset` box have one. */
function resetBoxOf(definition: CaseDefinition): Box {
  if (definition.reset === undefined || definition.anchor === undefined) {
    throw new LabError(`Case ${definition.id} has no fixed anchor and reset box, so there is no area to record.`);
  }
  const [x, y, z] = definition.anchor;
  const anchor = { x, y, z };
  return boxFromCorners(atOffset(anchor, definition.reset.from), atOffset(anchor, definition.reset.to));
}

/** `mclab harnesses`: lists the harness presets with their tools. */
export class HarnessesCommand extends Command {
  readonly name = "harnesses";
  readonly summary = "List harness presets and the tools each one gives the model";
  readonly usage = "Usage: mclab harnesses";
  protected readonly options = {} as const;

  protected execute(): Promise<number> {
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
      console.log(`${preset} (${config.harness}): ${config.description}`);
      console.log(
        `  tools: ${harness
          .tools()
          .map((tool) => tool.name)
          .join(", ")}`,
      );
    }
    return Promise.resolve(0);
  }
}

/** `mclab runs`: lists recorded runs with their status and cost. */
export class RunsCommand extends Command {
  readonly name = "runs";
  readonly summary = "List recorded runs (newest first)";
  readonly usage = "Usage: mclab runs [--config <lab.yaml>]";
  protected readonly options = { config: { type: "string" } } as const;

  protected execute(flags: Flags): Promise<number> {
    const runsDir = loadLabConfig(stringFlag(flags, "config")).runsDir;
    if (!existsSync(runsDir)) {
      console.log("No runs yet.");
      return Promise.resolve(0);
    }
    for (const runId of readdirSync(runsDir).sort().reverse()) {
      const manifestPath = join(runsDir, runId, "run.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        status?: string;
        totals?: { turns: number; steps: number; costUsd: number };
      };
      const totals = manifest.totals;
      const summary =
        totals === undefined ? "" : `${totals.turns} turns, ${totals.steps} steps, ${formatUsd(totals.costUsd)}`;
      console.log(`${runId}  ${manifest.status ?? "?"}  ${summary}`);
    }
    return Promise.resolve(0);
  }
}
