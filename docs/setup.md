# Setting up the lab

The full version of the README's quick start: what the lab needs, how the local server is set up, every config file,
and how to start and watch agents.

- [Requirements](#requirements)
- [Install](#install)
- [The local server](#the-local-server)
- [RCON](#rcon)
- [Check everything](#check-everything)
- [Configuration](#configuration)
- [Starting agents](#starting-agents)
- [Watching a run](#watching-a-run)
- [Troubleshooting](#troubleshooting)

## Requirements

- **Node.js 24 or newer.** `.nvmrc` pins 24 (`nvm use`). Node runs the TypeScript sources directly, so there is no
  build step.
- **Java 21 or newer**, to run the Minecraft server. The lab uses the first it finds of: `JAVA_HOME`, `java` on the
  `PATH`, and the runtime the Minecraft Launcher downloaded for the game, so players usually need not install Java. If
  `npm run doctor` finds none, install Java 21 (on macOS: `brew install openjdk@21`) or set `JAVA_HOME`.
- **Minecraft Java Edition 1.21.11**, to join the world: a launcher profile for that version.
- **An OpenAI API key**, for the model presets in `configs/models.yaml`. The `scripted-demo` preset needs none.

The code finds Minecraft folders on macOS, Windows and Linux.

## Install

```sh
npm ci
cp .env.example .env
```

Put your key after `OPENAI_API_KEY=` in `.env`. The lab reads `.env` when it starts; git ignores it. `.env.example`
lists the other variables: `JAVA_HOME`, and three that only the integration tests read (see
[CONTRIBUTING.md](../CONTRIBUTING.md)).

Then put your exact Minecraft name after `MCLAB_OWNERS=` in `.env` (several names: `Name1,Name2`). Only owners can
give the bots tasks. The variable replaces `owners` in `configs/lab.yaml`, so your name stays out of git; you can put
names in `owners` instead.

## The local server

Bots have no Microsoft account, so they can only join a server in offline mode; a world opened to LAN checks accounts
and turns them away. The lab therefore runs a vanilla 1.21.11 server on your machine, bound to `127.0.0.1` so that no
one else can reach it, in the folder `server/` (`server.directory` in `configs/lab.yaml`).

```sh
npm run server:setup -- --world "<path to your save folder>"
```

| Flag                    | Effect                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `--world <save folder>` | Copy a singleplayer save in as the server's world. The original save is not changed. |
| `--flat`                | For a new world: superflat.                                                          |
| `--seed <seed>`         | For a new world: this seed.                                                          |
| `--accept-eula`         | Record that you agree to the Minecraft EULA (https://aka.ms/MinecraftEULA).          |
| `--config <path>`       | Use another lab config.                                                              |

Setup downloads Mojang's `server.jar` for 1.21.11 and checks its SHA-1, then writes these settings into
`server/server.properties`, keeping the others:

| Setting                                     | Value                   | Why                                                                |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `online-mode`, `enforce-secure-profile`     | `false`                 | Bots without accounts can join.                                    |
| `server-ip`, `server-port`                  | `127.0.0.1`, `25565`    | Only this machine can connect.                                     |
| `enable-rcon`, `rcon.port`, `rcon.password` | `true`, `25575`, random | The lab's operator channel (see [RCON](#rcon)).                    |
| `broadcast-rcon-to-ops`                     | `false`                 | The lab's commands do not flood your chat.                         |
| `spawn-protection`, `allow-flight`          | `0`, `true`             | Bots may build near spawn, and are not kicked when they pillar up. |
| `level-name`, `motd`                        | `world`, the lab's name |                                                                    |

It also makes the owners operators. When it copies a save, it copies your player data to the UUID an offline-mode
server gives your name, so you keep your inventory and position.

The server will not start until you accept the EULA. Read https://aka.ms/MinecraftEULA; if you agree:

```sh
npm run server:setup -- --accept-eula
```

To replace the server's world later, close it in Minecraft and run
`npm run lab -- server import-world "<save folder>"`. The current server world is kept as a backup next to it.

A dedicated server uses the `difficulty` in `server/server.properties`, not the one saved in your world. Set
`difficulty=peaceful` there before starting if you want no hostile mobs.

Start the server in its own terminal and leave it running; type `stop` in it to stop it:

```sh
npm run server                  # the same as: npm run lab -- server start [--memory 4G]
```

In Minecraft, with the 1.21.11 profile: **Multiplayer → Direct Connection → `localhost`**.

## RCON

RCON is the server's operator channel. The lab uses it to set game modes, teleport players, give items, set case
scenes up and restore their areas, save world checkpoints, show the bot's action above your hotbar, and run server
commands for the `code-commands` harness. Setup turns it on with a random password; the lab reads the port and
password from `server/server.properties` (override them under `server.rcon` in `configs/lab.yaml`).

Without RCON the agents still play, but cases, trials, checkpoints and `!load` do not work, and those commands say
"is the server running?" or that RCON is missing. If the server restarts while the lab runs, the bot rejoins and RCON
reconnects on its own.

## Check everything

```sh
npm run doctor
```

It checks, in order: the Node version; Java; the lab config; the model presets, and that each agent's model exists and
its API key variable is set; every harness preset; the server jar; the EULA; offline mode; whether the server accepts
connections; and RCON (by listing the players online). Each failure comes with the command that fixes it.

## Configuration

Every config file is validated when it is loaded, and unknown keys are errors. `npm test` loads all of them, so a
broken edit fails the tests rather than a session.

### configs/lab.yaml

| Field                                 | Default                     | Meaning                                                                 |
| ------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `server.host`, `server.port`          | `127.0.0.1`, `25565`        | Where the bots join.                                                    |
| `server.version`                      | `1.21.11`                   | The Minecraft version.                                                  |
| `server.directory`                    | `server`                    | The server folder that setup creates.                                   |
| `server.rcon.enabled`                 | `true`                      | Use RCON. The other `rcon` fields default to `server.properties`.       |
| `owners`                              | required                    | Your exact Minecraft name(s); `MCLAB_OWNERS` in `.env` replaces them.   |
| `runsDir`                             | `runs`                      | Where run directories and trial logs go.                                |
| `checkpoints.enabled`, `dir`          | `true`, `checkpoints`       | World checkpoints, and where they are kept.                             |
| `checkpoints.everyMinutes`, `atStart` | `10`, `true`                | A checkpoint every N minutes (0 turns the timer off), and one at start. |
| `dashboard.enabled`, `host`, `port`   | `true`, `127.0.0.1`, `8787` | The web dashboard.                                                      |
| `agents`                              | at least one                | The bots to start (below).                                              |

Each agent:

| Field                                 | Default          | Meaning                                                        |
| ------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `name`                                | required         | The bot's player name, 3 to 16 letters, digits or underscores. |
| `model`                               | required         | A preset id from `configs/models.yaml`.                        |
| `harness`                             | required         | A preset name from `configs/harnesses/`.                       |
| `privileges.gameMode`                 | `survival`       | `survival` or `creative`, set when the bot joins.              |
| `budget.maxStepsPerTurn`              | `150`            | Model calls per turn.                                          |
| `budget.maxTurnMinutes`               | `30`             | Minutes per turn.                                              |
| `budget.maxTurnCostUsd`               | `3`              | Dollars per turn.                                              |
| `budget.maxRunCostUsd`                | `20`             | Dollars per run (until `!reset`).                              |
| `narration`                           | `actionbar`      | Show the bot's current action above your hotbar, or `off`.     |
| `joinOwner`                           | `true`           | Teleport the bot to the first online owner when it joins.      |
| `movement.canDig`, `allowScaffolding` | `false`, `false` | Let pathfinding dig through blocks, or pillar and bridge.      |

A budget that runs out ends the turn, and the bot says which limit it hit.

### configs/models.yaml

A list of model presets under `models`. `npm run lab -- models` lists them with prices.

| Field                              | Default                  | Meaning                                                                                                                                       |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | required                 | The name used in `lab.yaml`, `--model` and run directory names.                                                                               |
| `provider`                         | required                 | `openai` (the Responses API), or `scripted` (no API, for tests).                                                                              |
| `model`                            | required                 | The model name sent to the provider.                                                                                                          |
| `pricing`                          | required                 | US dollars per million tokens: `inputPerMTok`, `cachedInputPerMTok`, `outputPerMTok`, optional `cacheWritePerMTok`. Used only to report cost. |
| `maxOutputTokens`                  | `32000`                  | Output tokens per call, reasoning included.                                                                                                   |
| `timeoutMs`, `maxRetries`          | `240000`, `5`            | Time limit per call attempt, and retries on rate limits and errors.                                                                           |
| `description`                      | `""`                     | One line for listings.                                                                                                                        |
| `reasoningEffort`                  | the model's              | `openai` only: `none` to `max`.                                                                                                               |
| `reasoningSummary`, `verbosity`    | `auto`, the model's      | `openai` only: reasoning summaries shown on the dashboard, output verbosity.                                                                  |
| `parallelToolCalls`, `strictTools` | `true`, `true`           | `openai` only: several tool calls per response (they still run in order); strict tool schemas.                                                |
| `compactThreshold`                 | `200000`                 | `openai` only: compact the context past this many tokens; `null` turns it off.                                                                |
| `baseUrl`, `apiKeyEnv`             | OpenAI, `OPENAI_API_KEY` | `openai` only: another endpoint, and the variable that holds its key.                                                                         |

### configs/harnesses/\*.yaml

One file per preset; the file name is the preset name. `npm run lab -- harnesses` lists each preset with its tools.

| Field                                        | Default     | Meaning                                                                                                             |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `harness`                                    | required    | The harness class: `primitive`, `skills` or `code`.                                                                 |
| `description`                                | `""`        | One line for listings.                                                                                              |
| `tools`                                      | the default | Replace the harness's default tools with exactly these.                                                             |
| `excludeTools`                               | `[]`        | Remove these tools from the default set, for ablations.                                                             |
| `toolOutputMaxChars`                         | `8000`      | Tool output longer than this is cut in the middle before the model sees it (`20000` for `code`).                    |
| `observeOnMessage`                           | `true`      | Attach the bot's status and the owner's position to every owner message.                                            |
| `promptAppendix`                             | `""`        | Text appended to the system prompt, for prompt experiments.                                                         |
| `itemRequests`                               | `automatic` | Survival only: `automatic` grants `request_items` at once, `approval` waits for `!approve`, `off` removes the tool. |
| `commands`                                   | `false`     | Give the model server commands: the `run_command` tool, and `commands.run` in code.                                 |
| `helpers`                                    | `true`      | `code` only: give the code the `skills` library (`false` is the `code-raw` preset).                                 |
| `defaultTimeoutSeconds`, `maxTimeoutSeconds` | `60`, `900` | `code` only: the time limit of a `run_code` call, and the longest it may ask for.                                   |

## Starting agents

```sh
npm start                                         # every agent in configs/lab.yaml
npm start -- --model gpt-6-luna --harness skills  # flags override the config
```

| Flag                 | Effect                                                       |
| -------------------- | ------------------------------------------------------------ |
| `--config <path>`    | Another lab config.                                          |
| `--agent <name>`     | Start only this agent (repeatable).                          |
| `--name <name>`      | Rename the bot (only with a single agent).                   |
| `--model <id>`       | A model preset from `configs/models.yaml`.                   |
| `--harness <preset>` | A harness preset from `configs/harnesses/`.                  |
| `--game-mode <mode>` | `survival` or `creative`.                                    |
| `--no-dashboard`     | Do not start the web dashboard.                              |
| `--verbose`          | Print the model's text and full tool output in the terminal. |

The bot joins, is teleported to you, and waits for a task. With several agents, start a chat line with a bot's name
(`Sol, build a wall` or `@Sol build a wall`), or `@all` for every bot; a whisper (`/msg Sol ...`) always reaches that
bot. You can also type messages and commands (`!stop`, `!reset`, `!status`) in the terminal that runs `npm start`.
Ctrl-C ends the runs and the bots leave the server.

## Watching a run

- **Dashboard:** http://127.0.0.1:8787. A live timeline per agent: your messages, the model's reasoning summaries and
  replies, every tool call with its arguments, result and duration, executed code, the bot's status, token use and
  cost. You can send messages, stop and reset from it, and replay past runs.
- **In game:** the bot's current action appears above your hotbar. `/spectate <bot>` (in spectator mode) shows its
  view.
- **Terminal:** one line per model call and tool call.
- **Run directory:** `runs/<time>_<agent>_<harness>_<model>/` for every run, from the agent's start until `!reset` or
  shutdown:

| File                                     | Contents                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `run.json`                               | Agent, model, harness, privileges, start and end, status, totals (steps, tool calls, tokens, cost).          |
| `events.jsonl`                           | Every event, one JSON object per line; the run can be rebuilt from it.                                       |
| `transcript.md`                          | The run as readable text.                                                                                    |
| `block-changes.jsonl`                    | Every block change the bot saw, marked `bot` or `other`.                                                     |
| `snapshots/turn-NNN.{before,after}.json` | The region each turn changed, before and after (`mclab.snapshot.v1`: rows of `[x, y, z, name, properties]`). |
| `code/`                                  | Every program the code harnesses ran.                                                                        |
| `case.json`, `case-result-turn-NNN.json` | For a failure case: the case and its setup, and the checks after each turn.                                  |

`npm run lab -- runs` lists the runs, newest first.

### World checkpoints

While the lab runs, it saves complete copies of the server's world: one when it starts and one every 10 minutes
(`checkpoints` in `configs/lab.yaml`). To save a consistent copy, it turns the server's autosave off for a moment and
has it write everything to disk. Files that did not change since the previous checkpoint are hard-linked rather than
copied, and are made read-only because checkpoints share them.

```sh
npm run lab -- checkpoint save <label>     # or !save <label> in chat
npm run lab -- checkpoint list
npm run lab -- checkpoint open <id>        # a writable copy in your saves folder, to open in singleplayer
```

Delete old checkpoint folders whenever you like. Trials turn the timed checkpoints off unless asked
([docs/trials.md](trials.md)).

## Troubleshooting

| Symptom                                          | Fix                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run server` says the EULA is not accepted   | Read https://aka.ms/MinecraftEULA, then `npm run server:setup -- --accept-eula`.                                                                                                          |
| No Java found                                    | Install Java 21 (`brew install openjdk@21` on macOS), or set `JAVA_HOME`.                                                                                                                 |
| The bot cannot join: "Failed to verify username" | The server is in online mode; run `npm run server:setup` again (it sets `online-mode=false`).                                                                                             |
| You cannot join: "outdated client/server"        | Use the 1.21.11 launcher profile.                                                                                                                                                         |
| Your inventory is empty after importing          | The save had more than one player's data; copy `server/world/playerdata/<old uuid>.dat` by hand to your offline UUID (setup prints it).                                                   |
| "No RCON connection" warnings                    | The server is not running, or `server/server.properties` has no `rcon.password`; run setup again.                                                                                         |
| The bot ignores your messages                    | Your name is not in `MCLAB_OWNERS`, or several bots are running and you did not start with a name.                                                                                        |
| The bot is kicked for spamming                   | Chat is paced to one line per second, so long replies take a few seconds; wait.                                                                                                           |
| "Could not reach the OpenAI API (...)"           | The message ends with the network cause (`ENOTFOUND`: no DNS or internet). The bot retries for about 15 s, then on a fresh connection; once the network is back, send your message again. |
| `OPENAI_API_KEY is not set`                      | Put it in `.env` (see `.env.example`).                                                                                                                                                    |
| The dashboard does not load                      | Port 8787 is taken; change `dashboard.port` in `configs/lab.yaml`.                                                                                                                        |
| A case or trial says RCON is missing             | Start the server first (`npm run server`), then the lab.                                                                                                                                  |
