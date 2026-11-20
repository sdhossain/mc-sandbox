import { CaseLibrary } from "../../cases/case-library.ts";
import {
  countTrials,
  olderScoringCount,
  summariseTrials,
  TRIALS_FOLDER,
  TrialLog,
  verdictOf,
  type LoggedTrial,
} from "../../cases/trial-log.ts";
import { TrialRescorer } from "../../cases/trial-rescorer.ts";
import { AUTO_REPLY, TrialRunner, type TrialRecord } from "../../cases/trial-runner.ts";
import { ControlCommand } from "../../agent/chat-addressing.ts";
import { ConfigPaths, loadLabConfig, loadModelCatalog } from "../../config/load-config.ts";
import { Lab } from "../../lab/lab.ts";
import { DashboardServer } from "../../observability/dashboard/dashboard-server.ts";
import { ConfigError, errorMessage, LabError } from "../../utils/errors.ts";
import { MessageSource } from "../../utils/names.ts";
import { formatUsd, truncateEnd } from "../../utils/text.ts";
import { booleanFlag, Command, stringFlag, type Flags } from "../command.ts";
import { applyOverrides } from "./start-command.ts";

/** `mclab trials <case>`: runs a case several times, unattended, and logs every trial. */
export class TrialsCommand extends Command {
  readonly name = "trials";
  readonly summary = "Run a failure case several times unattended and log the results";
  readonly usage = `Usage: mclab trials <case id> [--repeat 5 | --until 5] [--model <id>] [--harness <preset>] [--game-mode <mode>]
       mclab trials <case id> --summary [--rescore [--save]]

Runs the case again and again on one agent (the first in configs/lab.yaml, or --agent), with nobody needed
at the keyboard or in the game, and appends every trial to runs/trials/<case>.jsonl and <case>.csv
(or the folder given with --log-dir).
Stop any other running lab first: the bot logs in under its usual name.

After each trial the case's area is saved as the agent left it, under a short id (t1, t2, ...). Put one
back into the world to look at it with "!load t7" in game, or "npm run lab -- load t7".

Nobody is there to answer questions: when the model ends its turn by asking something (its reply has a
question mark) and the case has not passed, the trial answers once, in the owner's name,
"${AUTO_REPLY}", and logs the question.

  --repeat <n>        Trials to run (default 5)
  --until <n>         Run only the trials still missing for n in the log, for this model, harness and game
                      mode: running it again after a crash finishes the set, and never runs more than n
  --model, --harness, --game-mode, --agent, --config   As for "start"
  --world-saves       Also save a copy of the whole world after each trial (about 20 MB each), which
                      "npm run lab -- checkpoint open <id>" opens in singleplayer
  --checkpoints       Keep the timed world checkpoints on (they are off during trials)
  --no-auto-reply     Do not answer questions: a question ends the trial
  --force             Rebuild a flattened case's site even when it looks built on
  --no-dashboard      Do not start the dashboard
  --log-dir <name>    Log to runs/<name>/ instead of runs/trials/ (the name must start with "trials-"),
                      for example to keep one harness's trials apart; --summary reads the same folder
  --summary           Print the per-model summary of the trials logged so far, and exit
  --rescore           With --summary: score every logged trial again from its saved end state with the
                      current checks (cases with a reset box only), list the verdicts that change, and
                      summarise the new scores. The logs are not changed
  --save              With --rescore: write the new scores into the log. Each rescored trial keeps its first
                      verdict under "asLogged", and the old log files are copied next to it first`;
  protected readonly options = {
    config: { type: "string" },
    agent: { type: "string", multiple: true },
    model: { type: "string" },
    harness: { type: "string" },
    "game-mode": { type: "string" },
    repeat: { type: "string" },
    "world-saves": { type: "boolean" },
    checkpoints: { type: "boolean" },
    force: { type: "boolean" },
    "no-auto-reply": { type: "boolean" },
    "no-dashboard": { type: "boolean" },
    summary: { type: "boolean" },
    rescore: { type: "boolean" },
    save: { type: "boolean" },
    until: { type: "string" },
    "log-dir": { type: "string" },
  } as const;

  protected async execute(flags: Flags, positionals: readonly string[]): Promise<number> {
    const [caseId] = positionals;
    if (caseId === undefined) {
      throw new ConfigError(`Which case? ${this.usage}`);
    }
    const library = CaseLibrary.load(ConfigPaths.CASES);
    const definition = library.get(caseId);
    const base = loadLabConfig(stringFlag(flags, "config"));
    const logDir = stringFlag(flags, "log-dir") ?? TRIALS_FOLDER;
    const log = new TrialLog(base.runsDir, caseId, logDir);
    const rescoreHint = `npm run lab -- trials ${caseId} --summary --rescore${logDir === TRIALS_FOLDER ? "" : ` --log-dir ${logDir}`}`;
    if (booleanFlag(flags, "rescore") && !booleanFlag(flags, "summary")) {
      throw new ConfigError("--rescore goes with --summary.");
    }
    if (booleanFlag(flags, "save") && !booleanFlag(flags, "rescore")) {
      throw new ConfigError("--save goes with --summary --rescore.");
    }
    if (booleanFlag(flags, "summary")) {
      let trials = log.read();
      if (booleanFlag(flags, "rescore")) {
        const rescorer = TrialRescorer.forCase(definition, library.baselinePath(caseId));
        const rescored = trials.map((trial) => rescorer.rescore(trial));
        console.log(`${describeRescoring(trials, rescored)}\n`);
        if (booleanFlag(flags, "save")) {
          const at = new Date().toISOString();
          const saved = rescored.map((trial, index) => {
            const before = trials[index];
            return before === undefined || trial === before
              ? trial
              : {
                  ...trial,
                  asLogged: before.asLogged ?? { passed: before.passed, checks: before.checks, rescoredAt: at },
                };
          });
          log.rewrite(saved, `before-rescore-${at.replace(/[:.]/g, "-")}`);
          console.log(`Saved the new scores in ${log.jsonlPath} and ${log.csvPath}; the old files are next to them.\n`);
        }
        trials = rescored;
      }
      console.log(`${summariseTrials(trials)}${olderScoringNote(trials, rescoreHint)}\n\nAll trials: ${log.csvPath}`);
      return 0;
    }
    const overridden = applyOverrides(base, flags);
    const [agentConfig] = overridden.agents;
    if (agentConfig === undefined) {
      throw new ConfigError("No agent to run.");
    }
    const answerQuestions = !booleanFlag(flags, "no-auto-reply");
    const until = stringFlag(flags, "until");
    const target = Number(until ?? stringFlag(flags, "repeat") ?? 5);
    if (!Number.isInteger(target) || target < 1) {
      throw new ConfigError(`--${until === undefined ? "repeat" : "until"} must be a whole number of at least 1.`);
    }
    // With --until, count the trials already logged under the same conditions and run only the rest.
    const done =
      until === undefined
        ? 0
        : countTrials(log.read(), {
            model: agentConfig.model,
            harness: agentConfig.harness,
            gameMode: agentConfig.privileges.gameMode,
            answersQuestions: answerQuestions,
          });
    const repeat = target - done;
    if (repeat <= 0) {
      console.log(
        `The log already holds ${done} trials of ${caseId} for ${agentConfig.model} | ${agentConfig.harness} | ${agentConfig.privileges.gameMode}; nothing to run.`,
      );
      return 0;
    }
    if (until !== undefined) {
      console.log(`The log holds ${done} of ${target} trials for these conditions; running ${repeat}.`);
    }
    const timed = booleanFlag(flags, "checkpoints");
    const config = {
      ...overridden,
      agents: [agentConfig],
      // Checkpoints stay available for --world-saves, but the timed ones are off unless asked for.
      checkpoints: {
        ...overridden.checkpoints,
        atStart: timed && overridden.checkpoints.atStart,
        everyMinutes: timed ? overridden.checkpoints.everyMinutes : 0,
      },
    };
    const worldSaves = booleanFlag(flags, "world-saves");

    const lab = await Lab.open(config, { models: loadModelCatalog() });
    if (!lab.server.available) {
      await lab.shutdown();
      throw new LabError('Trials need RCON to set up each run; see docs/setup.md, "RCON".');
    }
    if (worldSaves && lab.checkpoints === null) {
      await lab.shutdown();
      throw new LabError('--world-saves needs checkpoints, which "checkpoints.enabled" in configs/lab.yaml turns off.');
    }
    if (onlinePlayers(await lab.server.run("list")).includes(agentConfig.name.toLowerCase())) {
      await lab.shutdown();
      throw new LabError(
        `${agentConfig.name} is already on the server. Stop the lab that runs it (Ctrl-C), then try again.`,
      );
    }
    const dashboard =
      config.dashboard.enabled && !booleanFlag(flags, "no-dashboard")
        ? new DashboardServer(lab, config.dashboard)
        : null;
    const stop = { requested: false };
    const agent = lab.agents[0];
    process.on("SIGINT", () => {
      if (stop.requested) {
        process.exit(130);
      }
      stop.requested = true;
      console.log("\nStopping after this trial (Ctrl-C again to quit at once)...");
      void agent?.control(ControlCommand.STOP, config.owners[0] ?? "owner", MessageSource.CLI);
    });

    try {
      await dashboard?.listen();
      await lab.start();
      if (agent === undefined) {
        throw new LabError("No agent started.");
      }
      if (dashboard !== null) {
        console.log(`Dashboard: ${dashboard.url}`);
      }
      const runner = new TrialRunner(agent, lab.bus, {
        caseId,
        owner: config.owners[0] ?? "owner",
        force: booleanFlag(flags, "force"),
        answerQuestions,
      });
      // Trials are numbered after the ones already logged, so a set finished after a crash reads 1..n.
      for (let trial = done + 1; trial <= target && !stop.requested; trial += 1) {
        const logged = await keepEndState(await runner.run(trial), lab, worldSaves);
        log.append(logged);
        console.log(`\n[trial ${trial}/${target}] ${describe(logged)}\n`);
      }
    } catch (error) {
      console.error(`Trials stopped: ${errorMessage(error)}`);
      return 1;
    } finally {
      await dashboard?.close();
      await lab.shutdown();
    }
    const logged = log.read();
    console.log(`${summariseTrials(logged)}${olderScoringNote(logged, rescoreHint)}\n\nAll trials: ${log.csvPath}`);
    return 0;
  }
}

/** A warning when some trials were scored by an older checker, with the command that scores them again. */
function olderScoringNote(trials: readonly LoggedTrial[], rescoreHint: string): string {
  const older = olderScoringCount(trials);
  return older === 0
    ? ""
    : `\n\nNote: ${older} of ${trials.length} trials were scored by an older checker, which counted untouched ground in a copy's box as extra blocks, so their verdicts can be wrong. Score every trial with the current checks:\n  ${rescoreHint}`;
}

/** Which trials were scored again, and every verdict that changed. */
function describeRescoring(logged: readonly LoggedTrial[], rescored: readonly LoggedTrial[]): string {
  const changed = rescored.filter((trial, index) => trial !== logged[index]);
  const flipped = rescored.flatMap((trial, index) => {
    const before = logged[index];
    return before !== undefined && before.passed !== trial.passed
      ? [`  ${trial.stateId} (${trial.model}, trial ${trial.trial}): ${verdictOf(before)} -> ${verdictOf(trial)}`]
      : [];
  });
  const lines = [
    `Scored again with the current checks: ${changed.length} of ${logged.length} trials (the rest have no saved end state).`,
    flipped.length === 0 ? "No verdict changed." : `Verdicts that changed (${flipped.length}):`,
    ...flipped,
  ];
  return lines.join("\n");
}

/** Player names from the reply to `/list`, lower-cased. */
function onlinePlayers(reply: string): string[] {
  const names = reply.split(":")[1] ?? "";
  return names
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

/**
 * Saves the trial's end state (and a copy of the whole world, when asked) and gives it the next state id.
 * A failed save is reported and leaves the trial without that state; it does not stop the trials.
 */
async function keepEndState(record: TrialRecord, lab: Lab, worldSaves: boolean): Promise<LoggedTrial> {
  const stateId = TrialLog.nextStateId(lab.config.runsDir);
  let stateFile: string | null = null;
  try {
    stateFile = await lab.states.save(record);
  } catch (error) {
    console.warn(`[trials] Could not save the end state of trial ${record.trial}: ${errorMessage(error)}`);
  }
  let checkpoint: string | null = null;
  if (worldSaves) {
    try {
      checkpoint = (await lab.saveCheckpoint(`${stateId} ${record.caseId} ${record.model} trial ${record.trial}`)).id;
    } catch (error) {
      console.warn(`[trials] Could not save a copy of the world: ${errorMessage(error)}`);
    }
  }
  return { ...record, stateId, stateFile, checkpoint };
}

function describe(trial: LoggedTrial): string {
  const result = `${trial.model}: ${verdictOf(trial)} · ${trial.status} · ${trial.steps} steps · ${formatUsd(trial.costUsd)} · ${(trial.durationMs / 60_000).toFixed(1)} min`;
  const saved =
    trial.stateFile === null ? "end state not saved" : `saved as ${trial.stateId}: in game, !load ${trial.stateId}`;
  const world = trial.checkpoint === null ? "" : `; whole world: checkpoint ${trial.checkpoint}`;
  const asked = trial.autoReplies.map(
    (answered) =>
      `\n    asked in turn ${answered.turn}, answered automatically: "${truncateEnd(answered.question, 160)}"`,
  );
  return `${result}${asked.join("")}\n    ${saved}${world} (run ${trial.runId})`;
}
