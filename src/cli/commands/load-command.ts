import { CaseLibrary } from "../../cases/case-library.ts";
import { describeState, TrialStates } from "../../cases/trial-states.ts";
import { ConfigPaths, loadLabConfig } from "../../config/load-config.ts";
import { connectServerControl, worldDirectoryOf } from "../../lab/lab.ts";
import { LiveRegions } from "../../mcserver/live-regions.ts";
import { NullServerControl } from "../../minecraft/server-control/server-control.ts";
import { Command, stringFlag, type Flags } from "../command.ts";

/** `mclab load [id]`: the terminal's `!load`, which works without a lab running. */
export class LoadCommand extends Command {
  readonly name = "load";
  readonly summary = "Put a trial's saved end state (or a case's start state) into the world, like !load";
  readonly usage = `Usage: mclab load              list the trials' saved end states
       mclab load <state id>   put that trial's end state into the world, for example: mclab load t7
       mclab load <case id>    put the case's recorded start state back, for example: mclab load mirror-hut

Only the cells that differ are changed. The server must be running, with RCON; no lab is needed.
In game, with the lab running, "!load t7" does the same.

  --config <path>   Lab config (default configs/lab.yaml)`;
  protected readonly options = {
    config: { type: "string" },
  } as const;

  protected async execute(flags: Flags, positionals: readonly string[]): Promise<number> {
    const config = loadLabConfig(stringFlag(flags, "config"));
    const cases = CaseLibrary.load(ConfigPaths.CASES);
    const [id] = positionals;
    if (id === undefined) {
      const regions = new LiveRegions(new NullServerControl(), worldDirectoryOf(config));
      const list = new TrialStates(config.runsDir, cases, regions).list();
      if (list.length === 0) {
        console.log("No trial states are saved yet; trials save one each (npm run lab -- trials <case>).");
      }
      for (const trial of list) {
        const world = trial.checkpoint === null ? "" : `   (whole world: checkpoint ${trial.checkpoint})`;
        console.log(`${describeState(trial)}${world}`);
      }
      return 0;
    }
    const server = await connectServerControl(config);
    try {
      const states = new TrialStates(config.runsDir, cases, new LiveRegions(server, worldDirectoryOf(config)));
      console.log(await states.load(id));
    } finally {
      await server.close();
    }
    return 0;
  }
}
