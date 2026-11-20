# How the lab works

For anyone changing the code: how a message becomes actions in the game, where each part lives, and how to add a
harness, a tool, a model provider, a check type or a command.

- [The big picture](#the-big-picture)
- [Runs, turns and steps](#runs-turns-and-steps)
- [Components](#components)
- [Extending the lab](#extending-the-lab)
- [Coding standards](#coding-standards)
- [Testing](#testing)

## The big picture

```
Minecraft chat ──► Agent ──► AgentSession (turn loop) ──► LanguageModel (OpenAI Responses API)
dashboard / CLI ─┘   │              │  tool calls                 ▲
                     │              ▼                             │ tool results
                     │       ToolExecutor ──► Harness tools ──► GameServices (Mineflayer)
                     │                                             │ placer, breaker, navigator, scanner, ...
                     └── EventBus ──► run recorder, console, dashboard, in-game status line
```

The `Lab` (`src/lab/lab.ts`) opens the configs, connects RCON, starts one `Agent` per entry in `configs/lab.yaml`,
and owns what agents share: the event bus, the cases, the trial states and the world checkpointer. Each `Agent`
(`src/agent/agent.ts`) is one bot: a Mineflayer connection, a harness, a model, and the chat commands (`!stop`,
`!case` and the rest). The `AgentSession` (`src/agent/agent-session.ts`) is the loop that talks to the model.

The bot does nothing on its own. Every action comes from a model call, so everything in a trace can be attributed to
the model.

## Runs, turns and steps

- A **run** lasts from the agent's start until `!reset` or shutdown. Its conversation is append-only, and it is
  recorded in its own directory under `runs/`.
- A **turn** is one owner message, plus any steering messages that arrive while the agent works. Steering messages
  are delivered between steps, so the model sees them before its next call.
- A **step** is one model call and the tool calls it asked for, run one after another. If a call fails, the rest of
  that response is skipped and the model is told why, so it can re-plan with what it knows now.
- A turn ends when the model replies without calling a tool, when the owner sends `!stop`, or when a budget runs out
  (`budget` in the agent's config: steps, minutes and dollars per turn, dollars per run).

Before the model sees a tool result, it is cut to the harness's `toolOutputMaxChars` (the start and the end are kept,
with a note in the middle saying how much is missing). Every owner message carries a status line: the bot's position,
facing, held item and game mode, and the owner's position and gaze when the owner is online.

## Components

| Folder               | What is there                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/`         | `Agent`, `AgentSession` (the turn loop), the tool executor, chat addressing, the inbox, budgets, item approvals                                                            |
| `src/llm/`           | `LanguageModel` and its registry; `openai/` (the Responses API) and `scripted/` (a replayed script, for tests)                                                             |
| `src/harness/`       | `Harness` and its registry; `primitive/`, `skills/` and `code/` (with the code runner and the loop guard)                                                                  |
| `src/tools/`         | One class per tool, grouped by area (perception, movement, building, inventory, crafting, ...), and the tool registry                                                      |
| `src/skills/`        | `SkillLibrary`: build from a block list, fill, clear, gather, craft with ingredients, farm                                                                                 |
| `src/minecraft/`     | The game layer on Mineflayer: connection, navigator, placer, breaker, inventory, crafting, containers, scanner, region renderer, chat, block-change recorder, RCON control |
| `src/cases/`         | Case definitions, scene staging, checks, the trial runner, trial logs, saved states, rescoring                                                                             |
| `src/observability/` | The event schema and bus, the run recorder, transcripts, snapshots, the console sink, the in-game narrator, the dashboard                                                  |
| `src/mcserver/`      | Server setup: the jar download, `server.properties`, world import, Java discovery, checkpoints, region baselines                                                           |
| `src/config/`        | Config schemas and loading                                                                                                                                                 |
| `src/cli/`           | The `mclab` command line: one class per command in `commands/`, listed in `main.ts`                                                                                        |
| `src/lab/`           | The `Lab` that ties it together                                                                                                                                            |

**The model layer.** `LanguageModel.generate()` is a template method: it times the call, computes its cost from the
preset's prices, and calls the provider's `call()`. The OpenAI adapter uses the Responses API statelessly
(`store: false`): every request carries the whole conversation, so the trace holds everything the model saw. It
replays output items, reasoning included, verbatim on later requests, which OpenAI requires and which keeps the prompt
cache warm, and it asks the server to compact the context past `compactThreshold` tokens.

**Harnesses and tools.** A harness decides which tools the model gets and how the system prompt describes them;
everything else (the loop, chat, budgets, logging) is shared, so two runs that differ only in harness measure the
harness. `Harness.tools()` and `Harness.instructions()` are fixed and call the abstract `defaultToolNames()` and
`describeActionSpace()`. Presets in `configs/harnesses/` pick a harness class and adjust it: tools, item requests,
server commands, output limits.

**The code harnesses** run model code with `node:vm` in a context that holds `bot`, the `skills` helpers (unless
`helpers: false`), `commands.run` (with `commands: true`), `Vec3`, `mcData`, `Item`, a `state` object kept between
calls, `log` and `sleep`. Every call has a time limit, and loops are instrumented so that runaway code stops itself. When a
call ends, the timers and bot listeners it created are removed. This is not a security sandbox: the code has the same
access to the bot, and to the lab process, as the lab itself. Run it on your own local server.

**Cases and trials.** `CaseStage` sets a case's scene up over RCON, `evaluateCase` scores its checks after every
turn, `TrialRunner` runs a case unattended, `TrialLog` and `TrialStates` keep the results and end states, and
`TrialRescorer` scores logged trials again. See [docs/cases.md](cases.md) and [docs/trials.md](trials.md).

**Observability.** Everything that happens is an event on the `EventBus` (`src/observability/events.ts` lists them
with their payloads). Sinks subscribe to it: the run recorder writes `events.jsonl`, `transcript.md`, block changes and
snapshots; the console prints one line per call; the narrator shows the bot's action above the owner's hotbar; the
dashboard server streams events to the browser and replays recorded runs.

## Extending the lab

Every extension point is a registry keyed by a name: add a class, register it, import its module, and give it a name.

### A harness

1. Write `src/harness/<name>/<name>-harness.ts`: a config schema that extends `HarnessConfigSchema`, and a class that
   extends `Harness` and implements `defaultToolNames()` and `describeActionSpace()`.
2. Register it at the end of the file: `HARNESS_REGISTRY.register(HarnessName.<NAME>, ...)`, with the name added to
   `HarnessName` in `src/utils/names.ts`.
3. Import the module in `src/harness/index.ts`.
4. Add a preset: `configs/harnesses/<preset>.yaml`. `npm run lab -- harnesses` should list it with its tools, and
   `npm test` builds every preset's tools.

### A tool

1. Write a class that extends `Tool` in the right area of `src/tools/`, with a `name`, a `description` the model
   reads, a zod `parameters` schema and `execute()`. Optional arguments are `.nullable()`, because OpenAI's strict mode
   requires every property.
2. Give it a name in `ToolName` (`src/utils/names.ts`) and register it: `TOOL_REGISTRY.register(ToolName.<NAME>, ...)`.
   A new file must also be imported in `src/tools/index.ts`.
3. Add it to the default tools of the harnesses that should have it, or to a preset's `tools`.
4. Test it against the fake world (`tests/fakes/fake-game.ts`).

### A model provider

1. Write a class that extends `LanguageModel` and implements `call()`, with a config schema that extends the common
   model fields.
2. Give it a name in `ProviderName` and register it in `PROVIDER_REGISTRY`; import the module in `src/llm/index.ts`.
3. Add presets to `configs/models.yaml`, with prices.

### A check type for cases

1. Add a schema to `CaseCheckSchema` in `src/cases/case-definition.ts`.
2. Evaluate it in `evaluateCheck` in `src/cases/case-checks.ts`. If it compares with the scene's start, return its box
   from `baselineBoxOf`, so the case stage records it.
3. Test it in `tests/unit/case-checks.test.ts` with a map world, and document it in [docs/cases.md](cases.md#checks).
4. If it reads only blocks and the final reply, add it to the checks `TrialRescorer` can score again.

### A command

Write a class that extends `Command` in `src/cli/commands/` (its `name`, `summary`, `usage`, `options` for
`node:util` `parseArgs`, and `execute()`), and add an instance to `COMMANDS` in `src/cli/main.ts`.

## Coding standards

The code follows the conventions of [TamperBench](https://github.com/criticalml-uw/TamperBench), carried over to
strict TypeScript.

- **No build step.** Node runs the TypeScript directly, so the code uses only erasable syntax
  (`erasableSyntaxOnly` in `tsconfig.json`): no enums, no parameter properties, and relative imports end in `.ts`.
- **Registries keyed by names.** Harnesses, tools and model providers register themselves when their module is
  imported, and each package's `index.ts` imports every module. Names are `const` objects in `src/utils/names.ts`, not
  enums.
- **Validated configs.** Every config is a zod schema next to the class it configures, built with `z.strictObject`,
  so unknown keys are rejected with the file and the field.
- **Abstract base classes with template methods.** `Harness.tools()` calls `defaultToolNames()`;
  `LanguageModel.generate()` wraps `call()`. Overrides use `override` (`noImplicitOverride`).
- **Strict types.** `tsc` runs in strict mode with `noUncheckedIndexedAccess`; typescript-eslint runs
  `strictTypeChecked` and `stylisticTypeChecked`.
- **Docs.** Exported classes, methods and functions carry TSDoc comments; eslint-plugin-jsdoc enforces it in `src/`.
- **Layout.** One main class per file, kebab-case file names, one folder per component.
- **Formatting.** Prettier with a print width of 120 (`npm run format`).

## Testing

`npm test` runs the unit tests in `tests/unit/` against an in-memory fake world (`tests/fakes/fake-game.ts`), with no
server and no API key. They cover the agent loop (tool calls, invalid arguments, skipping after a failure, budgets,
`!stop`, steering), the OpenAI adapter, the code runner (state, time limits, runaway loops, cancellation, listener
cleanup), the skills, the case checks and the case scaffold, trials, logs, saved states and rescoring, region restores, the
RCON client, the dashboard server, and every file in `configs/`.

`MCLAB_ACCEPT_EULA=1 npm run test:integration` starts a throwaway 1.21.11 server in a temporary folder (setting the
variable accepts the Minecraft EULA for it) and tests the game layer against it: placing, reading back, stair facing,
digging, tilling and planting, rendering and walking. It then runs the whole lab with a scripted model, with a second
bot playing the owner. `MCLAB_LIVE_MODEL=<preset>` adds one real turn on the primitive harness and one on the code
harness with that model, capped at $0.25 each. `MCLAB_SERVER_JAR` points at a server jar to use instead of
downloading one.
