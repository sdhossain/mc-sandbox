# Contributing

This lab is research code that other people should be able to read, run and extend. The rules below keep it that way.

## Set up

```sh
nvm use                    # Node 24, from .nvmrc (any Node 24 or newer works)
npm ci
cp .env.example .env       # only needed to run models; tests need no key
npm run check
```

You need a Minecraft server only to run agents or the integration tests; see [docs/setup.md](docs/setup.md).

## Before every commit

```sh
npm run check              # typecheck, lint, format check, unit tests
```

CI runs the same command on Node 24 and 26 (`.github/workflows/check.yml`). `npm run format` applies the formatting.

The integration tests start a throwaway 1.21.11 server, so they download Mojang's server jar and need Java 21. Run
them by hand when you change the game layer (`src/minecraft/`, `src/mcserver/`) or the lab's wiring. Setting
`MCLAB_ACCEPT_EULA=1` says you accept the Minecraft EULA for that server:

```sh
MCLAB_ACCEPT_EULA=1 npm run test:integration
MCLAB_ACCEPT_EULA=1 MCLAB_LIVE_MODEL=gpt-6-luna npm run test:integration   # also one real turn per harness (costs cents)
```

## What goes where

| You want to                               | Read                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Add a failure case                        | [docs/cases.md](docs/cases.md); start with `npm run lab -- cases new <id>` |
| Run or compare trials                     | [docs/trials.md](docs/trials.md)                                           |
| Add a harness, a tool or a model provider | [docs/architecture.md](docs/architecture.md#extending-the-lab)             |
| Add a model preset or change prices       | `configs/models.yaml` (prices are only used to report cost)                |
| Change a harness preset                   | `configs/harnesses/<preset>.yaml`                                          |

Every file in `configs/` is validated by `npm test`, so a broken case or preset fails the tests, not a live session.

## Conventions

The code follows the conventions of [TamperBench](https://github.com/criticalml-uw/TamperBench), carried over to
strict TypeScript. In short:

- **No build step.** Node runs the TypeScript directly, so use only erasable syntax: no enums, no parameter
  properties, and relative imports end in `.ts`.
- **One main class per file**, kebab-case file names, one folder per component.
- **Registries keyed by names.** Harnesses, tools and model providers register themselves when their module is
  imported; names are `const` objects in `src/utils/names.ts`, not enums.
- **Validated configs.** Every config is a zod schema next to the class it configures, and unknown keys are rejected.
- **Abstract base classes with template methods**, and `override` on every override.
- **Docs and types.** `tsc` runs in strict mode with `noUncheckedIndexedAccess`, typescript-eslint runs
  `strictTypeChecked`, and exported classes, methods and functions carry TSDoc comments.
- **Tests for behaviour, not lines.** Add a unit test next to the area you change (`tests/unit/`); the fake world in
  `tests/fakes/fake-game.ts` stands in for the server.

Details and examples: [docs/architecture.md](docs/architecture.md#coding-standards).

## Data you should not commit

`.env`, `runs/`, `checkpoints/` and `server/` are ignored: they hold your API key, your recordings, and copies of your
world. Recorded case baselines (`configs/cases/<id>.baseline.json.gz`) are small and are committed, because a case
that resets an area cannot run without its baseline.
