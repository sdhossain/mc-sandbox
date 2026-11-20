# Minecraft harness lab

Language models play Minecraft Java 1.21.11 on your own computer, through harnesses that give them more or less
power. You join the same world, give a bot a task in chat ("build me a 5x5 oak hut next to me"), and watch it work.
Everything it sees and does is recorded.

The lab is for looking closely at what models can do before building a formal eval:

- **Harnesses** range from one game action per tool call to JavaScript against the live bot with server commands.
- **Full traces**: every model call, tool call, block change and before-and-after snapshot, on a live dashboard.
- **Failure cases** turn a task into a repeatable probe: the same scene every time, a task phrased the way a player
  would say it, and checks that score the result cell by cell.
- **Trials** run a case many times per model and harness, unattended, and keep every trial's end state so you can
  put it back into the world and look at it.

## Contents

- [Quick start](#quick-start)
- [Harnesses and game modes](#harnesses-and-game-modes)
- [Using the lab](#using-the-lab)
- [Failure cases and trials](#failure-cases-and-trials)
- [Documentation](#documentation)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## Quick start

You need:

| Requirement                    | Notes                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| Node.js 24 or newer            | `node -v`. Node runs the TypeScript directly; there is no build step.                        |
| Java 21 or newer               | Runs the server. The lab finds the one the Minecraft Launcher installed, or set `JAVA_HOME`. |
| Minecraft Java Edition 1.21.11 | To join the world (a launcher profile for 1.21.11).                                          |
| An OpenAI API key              | For the model presets in `configs/models.yaml`.                                              |

```sh
git clone https://github.com/sdhossain/mc-sandbox.git && cd mc-sandbox
npm ci                     # install the exact dependency versions
cp .env.example .env       # then put your key after OPENAI_API_KEY=
```

1. **Name yourself the owner.** Put your exact Minecraft name after `MCLAB_OWNERS=` in `.env`. Only owners can give
   the bots tasks.
2. **Set up the server with a copy of your world.** Close the world in Minecraft first, then:

   ```sh
   npm run server:setup -- --world "<path to your save folder>"
   ```

   Saves are in `~/Library/Application Support/minecraft/saves/` on macOS, `%APPDATA%\.minecraft\saves\` on Windows
   and `~/.minecraft/saves/` on Linux, unless your launcher profile uses its own game directory. Leave out `--world`
   for a new world, and add `--flat` for a superflat one. Your save is copied, never changed.

3. **Accept the EULA.** The server will not start until you do. Read https://aka.ms/MinecraftEULA; if you agree:

   ```sh
   npm run server:setup -- --accept-eula
   ```

4. **Start the server** and leave it running (type `stop` in it to stop it):

   ```sh
   npm run server
   ```

   In Minecraft, with the 1.21.11 profile: **Multiplayer → Direct Connection → `localhost`**.

5. **Check everything** in a second terminal. It says how to fix anything that fails:

   ```sh
   npm run doctor
   ```

6. **Start a bot.** The first command makes no API calls: the bot joins, looks around and says hello.

   ```sh
   npm start -- --model scripted-demo
   npm start
   ```

7. **Give it a task** in Minecraft chat, for example `build me a 5x5 oak plank hut right next to me, door facing me`.

Why a local server: bots have no Microsoft account, so they can only join a server in offline mode. The lab runs a
vanilla server bound to `127.0.0.1`, so no one else can reach it. More on setup, the server and the config files:
[docs/setup.md](docs/setup.md).

## Harnesses and game modes

A harness decides what the model can do. Pick one with `--harness <preset>`; `npm run lab -- harnesses` lists every
preset with its tools.

| Preset            | What the model gets                                                                                                                                  | What it shows                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `primitive`       | One game action per tool call: walk, place or break one block, craft one recipe, use an item                                                         | Step-by-step planning and persistence |
| `skills`          | The primitive tools plus skills that each do a sub-task: build from a block list, fill or clear a box, gather, craft with intermediates, farm a plot | Planning when execution is reliable   |
| `skills-approval` | `skills`, but each item request waits for you to answer `!approve` or `!deny <reason>` in chat                                                       | Asking for what it needs              |
| `skills-gather`   | `skills` without item requests: in survival the bot gathers or crafts everything                                                                     | Gathering and crafting chains         |
| `code`            | JavaScript against the live Mineflayer bot (the full API), with the skills as `skills.*` helpers                                                     | Programming the game                  |
| `code-raw`        | JavaScript against the raw Mineflayer API, no helpers                                                                                                | Programming from scratch              |
| `code-commands`   | `code` plus server commands (`/fill`, `/setblock`, `/clone`) from code and as a tool                                                                 | Building with no execution friction   |

The game mode is separate: `--game-mode survival` or `creative`. That separates "can it build?" from "can it gather
the materials?". In survival, item requests are granted at once except in `skills-approval` and `skills-gather`.
Server commands ignore survival rules.

How fast the bot builds depends on the harness. In the mirror-hut trials (295 blocks), `build_structure` placed about
3 blocks a second, while one `run_code` program with `/setblock` placed the whole copy in under a second.

Models are presets in `configs/models.yaml` (`npm run lab -- models` lists them with prices); choose one with
`--model <id>`.

## Using the lab

Type in Minecraft chat. Each message you send carries the bot's position plus yours, your facing and the block you
are looking at, so "here" and "this" work. A message sent while the bot is working arrives between its steps and
steers the task.

| In chat             | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| any message         | A task, or steering for the task in progress                            |
| `!stop`             | Stops the current model call or action at once                          |
| `!reset`            | Ends the run and starts a new one with an empty memory                  |
| `!status`           | What the bot is doing, and the run's steps and cost                     |
| `!case <id>`        | Runs a failure case (`!case` lists them); `!check` re-runs its checks   |
| `!load <id>`        | Puts a trial's saved end state (or a case's start state) into the world |
| `!save [label]`     | Saves a copy of the whole world now                                     |
| `!approve`, `!deny` | Answers an item request (`skills-approval`); `!deny` takes a reason     |
| `!help`             | Lists the commands                                                      |

With several bots, start a line with a name (`Sol, build a wall` or `@Sol build a wall`), or `@all` for every bot. You
can also type in the terminal that runs `npm start`.

Where to watch:

- **Dashboard:** http://127.0.0.1:8787 shows a live timeline per agent: your messages, the model's reasoning summaries,
  every tool call with its arguments, result and duration, executed code, token use and cost. It replays past runs.
- **In game:** the bot's current action appears above your hotbar; `/spectate <bot>` (in spectator mode) shows its
  view.
- **Run directory:** every run is saved in `runs/<time>_<agent>_<harness>_<model>/`: `events.jsonl` (every event),
  `transcript.md`, `run.json` (totals), `block-changes.jsonl`, before-and-after `snapshots/`, and `code/` for the code
  harnesses.
- **World checkpoints:** the lab saves a full copy of the server's world when it starts and every 10 minutes
  (`npm run lab -- checkpoint list`, `checkpoint open <id>` to open one in singleplayer).

Stop the agents with Ctrl-C; they end their runs and leave the server. To compare models or harnesses side by side,
put several agents in `configs/lab.yaml` and give each its own build site.

## Failure cases and trials

A failure case is a reproducible probe: a scene built the same way every time, a task phrased the way a player would
say it (no coordinates), and automatic checks where possible. Cases live in `configs/cases/`.

| Case            | Probes                                                                     | Scored                                    |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| `mirror-hut`    | Mirroring a 295-block hut onto a slope in your world, between marker posts | Cell by cell, at any allowed floor height |
| `mirror-shed`   | Reflecting a structure read from text, flipping east/west facings          | Cell by cell                              |
| `rotate-shed`   | Turning a structure a quarter turn onto a plot, facings turned with it     | Cell by cell                              |
| `hide-gold`     | Line of sight: hiding a block from you while you stand on a pillar         | By casting lines from your eye            |
| `round-wall`    | Drawing a circle on a grid, with no gaps                                   | Radius band and enclosure                 |
| `count-windows` | Grouping glass into windows when each layer is a separate text grid        | Keyword in the reply, and by reading      |
| `lookout-tower` | A brief with eight interacting requirements, one relative to a tree        | One check per requirement                 |
| `sheep-pen`     | Enclosure on uneven ground (fence height across a step)                    | By you: walk the fence                    |

```sh
npm run lab -- cases                    # list the cases (this also validates every case file)
npm run lab -- cases mirror-hut         # what one probes, its task and its checks
```

Run one in chat with `!case <id>`: the agent starts a fresh run, the lab sets the scene up over RCON and sends the
task as if you had typed it, and after every turn the checks run and the result appears in chat and on the dashboard.

Run a case many times per model, unattended, and compare (the server must be running and no other lab):

```sh
scripts/run-trials.sh mirror-hut 5 gpt-6.2-sol gpt-6.2-astra       # skills harness, survival
HARNESS=code-commands LOG_DIR=trials-code-commands scripts/run-trials.sh mirror-hut 5 gpt-6.2-sol
npm run lab -- trials mirror-hut --summary                         # passes, blocks right, cost, time
npm run lab -- trials mirror-hut --summary --rescore               # the same, scored again with the current checks
```

The script fills each model up to the number you give (running it again only adds the missing trials, and it
starts again after a crash). Every trial's end state is saved under a short id (`t1`, `t2`, ...); `!load t7` in chat
puts it back into the world.

**Write your own case** in a few minutes: `npm run lab -- cases new <id>` writes a commented template that already
runs, and [docs/cases.md](docs/cases.md) walks through scenes, checks and baselines, with the mirror-hut case as a
worked example. Trials, logs and scoring are in [docs/trials.md](docs/trials.md).

## Documentation

| Guide                                        | Read it to                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| [docs/setup.md](docs/setup.md)               | Install, set up the server, configure the lab, models and harnesses            |
| [docs/cases.md](docs/cases.md)               | Write a failure case: scenes, coordinates, checks, baselines, a worked example |
| [docs/trials.md](docs/trials.md)             | Run trials, read the logs, rescore, and inspect end states                     |
| [docs/architecture.md](docs/architecture.md) | Understand the code, and add a harness, tool or model provider                 |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Develop: checks, tests, conventions                                            |

## Development

```sh
npm run check              # typecheck, lint, format check and unit tests: run before every commit
npm run format             # apply formatting
npm test                   # unit tests only: an in-memory fake world, no server or API key
MCLAB_ACCEPT_EULA=1 npm run test:integration   # a throwaway 1.21.11 server; you accept the EULA for it
```

CI runs `npm run check` on Node 24 and 26 for every push and pull request. The code is strict TypeScript that Node
runs directly; the conventions (registries, validated configs, one class per file) are in
[docs/architecture.md](docs/architecture.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

```
src/        agent/ harness/ tools/ skills/ llm/ minecraft/ cases/ observability/ mcserver/ config/ cli/ lab/
configs/    lab.yaml, models.yaml, harnesses/*.yaml, cases/*.yaml (+ templates/ and recorded baselines)
scripts/    trial runners: run-trials.sh, and one script per model in trials/ and trials-code-commands/
tests/      unit/ (no server needed), integration/ (a real server), fakes/
docs/       the guides above
```

## Troubleshooting

| Symptom                                          | Fix                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `npm run server` says the EULA is not accepted   | Read https://aka.ms/MinecraftEULA, then `npm run server:setup -- --accept-eula`              |
| No Java found                                    | Install Java 21 (`brew install openjdk@21` on macOS) or set `JAVA_HOME`                      |
| The bot cannot join: "Failed to verify username" | The server is in online mode; run `npm run server:setup` again (it sets `online-mode=false`) |
| You cannot join: "outdated client/server"        | Use the 1.21.11 launcher profile                                                             |
| "No RCON connection" warnings                    | The server is not running, or `server/server.properties` has no `rcon.password`; rerun setup |
| The bot ignores your messages                    | Your name is not in `MCLAB_OWNERS`, or several bots run and you did not start with a name    |
| "Could not reach the OpenAI API (...)"           | The message ends with the network cause; the bot retries, then send your message again       |
| The dashboard does not load                      | Port 8787 is taken; change `dashboard.port` in `configs/lab.yaml`                            |

More in [docs/setup.md](docs/setup.md#troubleshooting).
