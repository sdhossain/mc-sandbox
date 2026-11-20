# Running trials

A trial is one unattended run of a failure case: a fresh conversation, the case's scene set up again, the task sent,
and the checks scored when the agent is done. Running a case several times per model and harness shows what fails
reliably and what is noise. This guide covers running trials, the files they write, scoring them again, and looking
at any trial's result in the world. To write a case, see [docs/cases.md](cases.md).

- [What one trial does](#what-one-trial-does)
- [Running trials](#running-trials)
- [What is written](#what-is-written)
- [Summaries and rescoring](#summaries-and-rescoring)
- [Looking at a trial](#looking-at-a-trial)
- [Comparing fairly](#comparing-fairly)

## What one trial does

1. **Start the case** as `!case <id>` would: the agent ends its run and starts a new one with an empty memory, the
   lab sets the scene up (a generated scene is rebuilt; a scene in your world is put back from its baseline), places
   the bot, and sends the task in the owner's name.
2. **Wait for the turn to end.** The agent works until it replies without calling a tool, or a budget in
   `configs/lab.yaml` ends the turn (by default 150 steps, 30 minutes or $3). The checks are scored after the turn.
3. **Answer one question.** Nobody is there to answer, so if the turn ended normally, the reply contains a question
   mark and the case has not passed, the trial answers once, in the owner's name: _"I'm not around; use your best
   judgement and finish."_ It then waits for that turn too. The trial ends after the next turn, whatever it says.
   `--no-auto-reply` turns this off, so a question ends the trial.
4. **Stop a runaway turn.** If a turn runs 5 minutes past its time budget, the trial stops it (`!stop`), scores what
   is there, and records the status `timeout`.
5. **Keep the result.** The case's area is saved as the agent left it, the trial gets a short state id (`t1`, `t2`,
   ...), and one line is appended to the trial log. Steps, tool calls, cost and time add up every turn of the trial.

## Running trials

The Minecraft server must be running with RCON (`npm run server`), and no other lab may run: the trial bot logs in
under the agent's usual name. A case with a fixed anchor (a scene in your world) needs nobody online, and for
comparisons it is better if you are not (see [Comparing fairly](#comparing-fairly)). A generated scene is built around
the owner, so for those cases the owner must be in the game, near the bot.

```sh
npm run lab -- trials mirror-hut --repeat 5 --model gpt-6.2-sol --harness skills --game-mode survival
```

| Flag                                  | Effect                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repeat <n>`                        | Trials to run (default 5).                                                                                                                                                                                                  |
| `--until <n>`                         | Run only the trials still missing for `n` in the log for this model, harness and game mode. Running it again after a crash finishes the set, and a set never grows past `n`. New trials are numbered after the logged ones. |
| `--model`, `--harness`, `--game-mode` | Override the agent's model preset, harness preset and game mode, as for `npm start`.                                                                                                                                        |
| `--agent <name>`, `--config <path>`   | Which agent of the lab config to use (default: the first), and which lab config.                                                                                                                                            |
| `--log-dir <name>`                    | Log to `runs/<name>/` instead of `runs/trials/`. The name must start with `trials-`.                                                                                                                                        |
| `--no-auto-reply`                     | Do not answer questions: a question ends the trial.                                                                                                                                                                         |
| `--world-saves`                       | Also save a copy of the whole world after each trial (about 20 MB each).                                                                                                                                                    |
| `--checkpoints`                       | Keep the timed world checkpoints on; they are off during trials.                                                                                                                                                            |
| `--force`                             | Rebuild a generated scene even where the site looks built on.                                                                                                                                                               |
| `--no-dashboard`                      | Do not start the dashboard (by default it runs, so you can watch at http://127.0.0.1:8787).                                                                                                                                 |
| `--summary`                           | Print the summary of the trials logged so far, and exit. Add `--rescore` to score them again.                                                                                                                               |
| `--save`                              | With `--summary --rescore`: write the new scores into the log (see below).                                                                                                                                                  |

Ctrl-C stops after the current trial; a second Ctrl-C quits at once.

### Scripts

`scripts/run-trials.sh` runs a case for several models, one after another, until the log holds the given number of
trials for each model, and prints the summary at the end:

```sh
scripts/run-trials.sh                                          # mirror-hut, 5 trials each for four models
scripts/run-trials.sh mirror-hut 5 gpt-6.2-sol gpt-6.2-astra   # a case, the number of trials, the models
HARNESS=code-commands LOG_DIR=trials-code-commands scripts/run-trials.sh mirror-hut 5 gpt-6.2-sol
```

| Variable      | Default    | Effect                                                       |
| ------------- | ---------- | ------------------------------------------------------------ |
| `HARNESS`     | `skills`   | The harness preset.                                          |
| `GAME_MODE`   | `survival` | The game mode.                                               |
| `LOG_DIR`     | none       | Log to `runs/<LOG_DIR>/`; the summary reads the same folder. |
| `WORLD_SAVES` | `0`        | `1` adds `--world-saves`.                                    |
| `AUTO_REPLY`  | `1`        | `0` adds `--no-auto-reply`.                                  |

The script passes `--until`, so only the missing trials run: running it again never takes a model past the number
you gave. If the lab stops early (a crash or a lost connection), the script starts it again for the trials still
missing, up to 3 times per model; Ctrl-C stops the script. There is one script per model for each harness used so
far: `scripts/trials/<model>.sh` (skills harness, logs in `runs/trials/`) and `scripts/trials-code-commands/<model>.sh`
(code-commands harness, logs in `runs/trials-code-commands/`). Each fills mirror-hut up to 5 trials; `CASE`, `REPEATS`,
`GAME_MODE` and `LOG_DIR` change that. For more trials of the same conditions, raise `REPEATS` or log to a new folder.

## What is written

| Where                      | What                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs/trials/<case>.jsonl` | One JSON line per trial, with everything: checks with their details and metrics, questions asked, status, totals, the state id and file.                                                                               |
| `runs/trials/<case>.csv`   | One row per trial, for spreadsheets (columns below).                                                                                                                                                                   |
| `runs/trials-<name>/`      | The same two files, for trials run with `--log-dir trials-<name>`.                                                                                                                                                     |
| `runs/<run id>/`           | The trial's run directory: `events.jsonl`, `transcript.md`, `case.json` (the case, its anchor and the setup commands), `case-result-turn-NNN.json` after each turn, and the saved end state `case-area.after.json.gz`. |
| `checkpoints/<id>/`        | With `--world-saves`: a copy of the whole world after the trial.                                                                                                                                                       |

State ids count up across every case and every trials folder, so `t17` names one trial in the whole lab.

The CSV columns:

| Column                                           | Meaning                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `state_id`                                       | The trial's saved end state, for `!load`.                                                                                               |
| `case`, `model`, `harness`, `game_mode`, `trial` | What ran; `trial` counts within one `trials` command.                                                                                   |
| `passed`                                         | Every check passed after the last turn.                                                                                                 |
| `blocks_right`, `blocks`                         | From the first check that reports numbers (the copy check, for copy cases): the original's blocks reproduced right, out of all of them. |
| `extra_blocks`                                   | Blocks where the copy should be empty.                                                                                                  |
| `matching`, `total`, `wrong_cells`               | Cells that match, cells compared, cells that do not match.                                                                              |
| `plain_matching`                                 | For a mirror: how many cells an unmirrored copy in the same place would match.                                                          |
| `bottom_y`                                       | The copy's floor height chosen by the check.                                                                                            |
| `status`                                         | How the last turn ended: `completed`, `stopped`, `budget`, `failed` or `timeout`.                                                       |
| `answers_questions`, `auto_replies`              | Whether questions were answered, and how many were.                                                                                     |
| `steps`, `tool_calls`, `cost_usd`, `minutes`     | Totals over the trial's turns.                                                                                                          |
| `run_id`, `checkpoint`, `started_at`             | The run directory, the world save (if any), and the start time.                                                                         |

## Summaries and rescoring

```sh
npm run lab -- trials mirror-hut --summary
npm run lab -- trials mirror-hut --summary --log-dir trials-code-commands
```

The summary has one line per set of conditions (model, harness and game mode): trials, passes, how many trials the
model stopped to ask a question, the mean share of the original's blocks built right, the mean number of extra
blocks, and the mean cost and time. Trials logged before questions were answered automatically are kept on their own
line, marked `no auto-reply`, because they ran under a different protocol.

`--rescore` scores every logged trial again, from its saved end state, with the current checks, and lists the
verdicts that change before the summary. Use it after the checks change, so that old and new trials are scored the
same way. On its own it does not change the logs. When the summary finds trials scored by an older checker, it says so
and prints the command.

`--save` writes the new scores into the log, so that the summary, the CSV and `!load` all show them. Each trial whose
score changed keeps its first verdict and checks under `asLogged`, with the time they were replaced, and the old log
files are copied next to the new ones first (`<case>.jsonl.before-rescore-<time>`).

```
$ npm run lab -- trials mirror-hut --summary --rescore --log-dir trials-code-commands
Scored again with the current checks: 15 of 15 trials (the rest have no saved end state).
Verdicts that changed (10):
  t21 (gpt-6.1-terra, trial 1): FAIL: 295/295 blocks right, 14 extra -> PASS: 295/295 blocks right, 0 extra
  ...
model | harness | mode                    trials  passed  asked  blocks right (mean)  extra (mean)  cost (mean)  minutes (mean)
gpt-6.1-terra | code-commands | survival       5     4/5    0/5                91.2%          10.4      $0.0625             1.1
gpt-6.2-sol | code-commands | survival         5     4/5    0/5               100.0%           0.2        $0.11             1.4
gpt-6.2-astra | code-commands | survival       5     5/5    0/5               100.0%           0.0        $0.28             1.0
```

That example is real: those ten huts were perfect, and the checker of the time failed them only because grass the
bots never touched stood inside the copy's box on the slope. The checker now scores such cells as untouched ground
([how a copy is scored](cases.md#how-a-copy-is-scored)).

Rescoring needs what the end state alone can show. It works for cases with a `reset` box and a recorded baseline and
no `setup` or `damage` commands, because then the baseline is the start of every trial. It re-evaluates `block`,
`count`, `copy`, `unchanged` and `reply` checks; `inventory`, `hidden`, `ring` and `restored` keep their logged
results. A trial whose end state was not saved keeps its logged result.

## Looking at a trial

Every trial's end state can be put back into the world, so you can walk around what the agent built. In chat, with
the lab running, stand near the case's area:

```
!load              lists the newest saved states: t35 gpt-6.2-astra #5 FAIL 295/295; t34 ...
!load t7           puts trial t7's end state into the area (only the cells that differ change)
!load mirror-hut   puts the case's start state back
```

`npm run lab -- load t7` does the same from a terminal, with only the server running, and `npm run lab -- load`
lists every saved state. Loading refuses while the bot is working on a task (`!stop` first). The lists show each
trial's verdict as it was logged, not rescored.

To see what the agent did, open the trial's run on the dashboard (http://127.0.0.1:8787 replays past runs), or read
`transcript.md` and `events.jsonl` in its run directory. A trial saved with `--world-saves` can be opened in
singleplayer: `npm run lab -- checkpoint open <id>`.

## Comparing fairly

When you compare models or harnesses, change one thing at a time and keep everything else the same:

- **The same case, prompt and game mode,** and the same budgets in `configs/lab.yaml`.
- **The same people online.** Every message the bot gets carries a status line, and when the owner is on the server
  it includes the owner's position and gaze. In the mirror-hut experiment the owner was offline during the skills
  trials and online, standing on a marker post, during the code-commands trials, so the two harnesses did not get the
  same task message. Log out while trials run.
- **The same tool output limits.** Tool results longer than a harness's limit are cut in the middle with a note
  saying how much is missing. The limit is 8,000 characters by default and 20,000 for the code harnesses
  (`toolOutputMaxChars` in the preset), and a cut inspection can hide part of a scene. Set the same value in both
  presets when the comparison should change only the tools.
- **The same scoring.** If the checks changed between two sets of trials, compare `--summary --rescore` results.
- **Report what you leave out,** and why: a trial lost to a dropped connection, or a batch run under another
  protocol. The `no auto-reply` line in the summary keeps such a batch apart.
