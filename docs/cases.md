# Writing a failure case

A failure case is a reproducible probe of something models get wrong. It has three parts: a scene that is the same
every time, a task phrased the way a player would say it, and checks that score the result. Cases live in
`configs/cases/<id>.yaml`, one file each. This guide shows how to write one, from a template to a scored trial.

- [What makes a good case](#what-makes-a-good-case)
- [Quick start](#quick-start)
- [Coordinates and placeholders](#coordinates-and-placeholders)
- [Generated scenes](#generated-scenes)
- [Scenes in your own world](#scenes-in-your-own-world)
- [Worked example: mirror-hut](#worked-example-mirror-hut)
- [Reference](#reference): [fields](#case-file-fields), [checks](#checks), [how a copy is scored](#how-a-copy-is-scored)
- [Testing a case](#testing-a-case)
- [Troubleshooting](#troubleshooting)

## What makes a good case

- **It probes one thing you expect to fail,** and says so in `hypothesis`: what models will get wrong, and what that
  looks like in the build or the trace. A few cases that are likely to fail teach more than many easy ones.
- **The task sounds like a player.** No coordinates, sizes or block counts unless a player would give them. The model
  should have to find the scene and work out the geometry itself.
- **The checks decide pass or fail without you,** where possible. Check what the task asks for and nothing more:
  checks that are stricter than the task measure the checker, not the model.
- **What the checks cannot see goes in `watch`:** how the model inspects the scene, what it asks, what it leaves
  behind. Read those in the trace.
- **It runs the same way every time.** A generated scene is rebuilt from commands; a scene in your world is put back
  from a recorded baseline. Either way, every run starts from the same blocks.

## Quick start

```sh
npm run lab -- cases new copy-stack              # a scene built on flattened ground around you
npm run lab -- cases new my-scene --existing     # a scene in your own world, at a fixed place
```

Both write `configs/cases/<id>.yaml` from a commented template in `configs/cases/templates/`. The new case is valid
as written, so you can run it at once and change it step by step:

1. Edit the file: the scene, the prompt and the checks. The rest of this guide explains each part.
2. Check it: `npm run lab -- cases copy-stack` prints what the case probes, its task and its checks. Every case file
   is validated when the cases are loaded, so a mistake is reported with the file and the field.
3. Try it: start the lab (`npm start`, with the case's game mode) and type `!case copy-stack` in chat. The bot starts
   a fresh run, the lab sets the scene up, and the task is sent as if you had typed it.
4. Read the result: after every turn the checks run, and the result appears in your chat and on the dashboard. `!check`
   runs them again, for example after you answered a question the bot asked.
5. Run it many times: [docs/trials.md](trials.md).

## Coordinates and placeholders

Every position in a case file is an offset `[dx, dy, dz]` from the **anchor**: x points east, y up, z south.

- Without an `anchor` field, the anchor is the block you stand in when you type `!case <id>`, so the case runs
  anywhere. The lab must see you to build the scene around you.
- With `anchor: [x, y, z]`, the case is tied to that place in the world, and it does not matter where you stand.

The lab runs every setup and damage command as `execute positioned <anchor> run <command>`, so `~` in a command is the
anchor too: `fill ~-2 ~ ~-4 ~-1 ~2 ~-3 oak_planks` fills offsets (-2, 0, -4) to (-1, 2, -3). In commands and the
prompt, `{owner}` and `{bot}` become the player names. In the prompt, `{x}`, `{y}` and `{z}` become the anchor's
coordinates, with an optional offset: `{y+2}`, `{z-6}`. Player positions (`owner.at`, `bot.at`) may be fractional.

## Generated scenes

`scene: flatten` is the default. `!case <id>` then does the following, in order:

1. **Flatten the site.** Everything within `site.radius` blocks of the anchor (horizontally) becomes air up to
   `site.height` blocks above the anchor, with grass one block below the anchor and dirt below that, down to 4 blocks
   below it. Loose items nearby are removed.
2. **Place the players.** The bot's inventory is emptied and it is teleported to `bot.at`. You are teleported to
   `owner.at`, facing `owner.facing`, unless `owner` is `null`.
3. **Build the scene** with the `setup` commands.
4. **Record the start.** After a 1.5-second pause for the bot to see the changes, the lab reads every box the checks
   compare with the start (see [`restored`](#restored), [`unchanged`](#unchanged) and [`copy`](#copy)).
5. **Damage it** with the `damage` commands, if there are any, and record the boxes again: this is the scene the
   agent is shown.
6. **Send the task.** The prompt, with its placeholders filled, goes to the agent in a fresh run, as if you had typed
   it.

Because flattening replaces everything in the site, the lab refuses to run a flattened case where the site looks built
on (planks, glass, doors, wool and other blocks that rarely occur naturally). Move to open ground, use a test world, or
type `!case <id> force` to replace the site anyway.

A case can also require something of the anchor: `requires: { negativeX: true }` refuses to run unless x is negative,
for cases that probe rounding below zero.

## Scenes in your own world

Some scenes are better built by hand, or already exist: a structure the bot built earlier, a slope, a cave. For those,
set `scene: existing`, a fixed `anchor`, and a `reset` box. Nothing is flattened. Before every run, the lab puts the
reset box back to the state recorded in `configs/cases/<id>.baseline.json.gz`, changing only the cells that differ.
Then it places the players and runs any `setup` and `damage` commands, as for a generated scene.

To set one up:

1. **Build the scene** on the lab's server (the world the bots play in), or import a world that has it
   (`npm run lab -- server import-world "<save folder>"`).
2. **Pick the anchor.** Stand where the bot should start or next to the scene, and press F3: the block you stand in
   (`Block:` in the debug screen) is the anchor. Put it in `anchor`.
3. **Size the reset box.** It must hold the scene, the space the agent works in, and a margin for scaffolding or a
   stray block. Every cell of it is recorded and restored, so keep it as small as that allows.
4. **Save a checkpoint** before any run changes the scene: `!save <label>` in chat, or
   `npm run lab -- checkpoint save <label>` from a terminal while the server runs. `npm run lab -- checkpoint list`
   shows the ids.
5. **Record the start state** from that checkpoint:

   ```sh
   npm run lab -- cases baseline my-scene --from <checkpoint id>
   ```

   It reads the box from the checkpoint's world files, so the server need not be running. Every cell of the box must
   have been generated.

6. **Try it** with `!case my-scene`. To put the area back by hand at any time, with the server running:
   `npm run lab -- cases reset my-scene` (or `!load my-scene` in chat).

If you change `anchor` or `reset` later, record the baseline again: the lab refuses a baseline that covers a different
box than the case. Record it from a checkpoint taken before any run, so that no run's leftovers end up in every later
run. Commit the baseline file with the case: a case with a reset box cannot run without it.

## Worked example: mirror-hut

`mirror-hut` asks the bot to build the mirror image of a hut on a slope, between pink wool markers. It is a scene in
the owner's world, and this is how it was made.

**The scene.** The lab's own bot built the hut in two ordinary sessions on the lab's server: "build a modest house at
the top of this hill", then "expand the house and use slabs". The owner then placed four pink wool posts by hand, one
block outside a 7 × 13 space on the slope east of the hut, and a four-block pink pillar inside it.

**The measurements.** A checkpoint of that scene (`!save scene-for-mirror-case`) was read block by block. The hut is
295 blocks in x -85 to -79, y 123 to 131, z 110 to 122. The space between the posts is x -70 to -64, z 107 to 119:
the same 7 × 13 footprint, 7 blocks lower, on ground that falls from y 116 to 114.

**The case file** (`configs/cases/mirror-hut.yaml`, shortened):

```yaml
id: mirror-hut
gameMode: survival
scene: existing
anchor: [-64, 117, 107] # where the owner stood; every offset below is from here
reset: { from: [-28, -7, -7], to: [8, 18, 21] } # x -92..-56, y 110..135, z 100..128
owner: null # the owner is not moved
bot: { at: [0.33, 0, 0.42] } # the north-east corner of the marked space
prompt: >-
  Go to the pink pillar. Build a mirror image of the hut on top of the hill between the four pink wool
  corner markers next to it, as if a mirror stood between the hut and that space.
checks:
  - label: mirror image of the hut between the pink wool (any floor height)
    copy:
      from: [-21, 6, 3] # the hut: x -85..-79, y 123..131, z 110..122
      to: [-15, 14, 15]
      mirror: { axis: x, about: -10.5 } # the plane x = -74.5
      offset: [0, 0, -3] # then 3 blocks north, into the marked space
      searchY: [-11, -4] # the copy's floor may be anywhere from y 112 to 119
      ignore: pink_wool # the bot may build around the markers or remove the pillar
      ignoreProperties: [axis] # wood grain direction: the skills tools cannot set it
  - label: the original hut is untouched
    unchanged: { from: [-21, 6, 3], to: [-15, 14, 15] }
```

Each number in the copy check comes from the geometry. The mirror plane lies halfway between the hut's east wall
(x -79) and the space's west edge (x -70): x = -74.5, which is `about: -10.5` from the anchor's x of -64. A pure
reflection would land at the hut's z (110 to 122), but the posts mark z 107 to 119, so `offset` moves the copy 3 blocks
north. The space is lower than the hut and slopes, so no single floor height is right: `searchY` tries every floor
from y 112 to 119 and keeps the best. The hut is nearly symmetric east to west (a plain copy differs from the mirror
image in only 8 cells), so the check also reports what an unmirrored copy in the same place would score.

**The start state.** Fixed-anchor scenes were added to the case runner for this case. The baseline was recorded from
the checkpoint taken just before the first run:

```sh
npm run lab -- cases baseline mirror-hut --from 20261120-003343_lab-start
```

That is 27,898 cells (37 × 26 × 29) in 43 block states.

**Running it.** One look with a live bot, then trials, then the scores:

```sh
npm start -- --harness skills --game-mode survival --model gpt-6.2-sol     # then !case mirror-hut in chat
scripts/run-trials.sh mirror-hut 5 gpt-6.1-terra gpt-6.2-sol gpt-6.2-astra
npm run lab -- trials mirror-hut --summary --rescore
```

What the trials showed, and why each failure happened, is the subject of [docs/trials.md](trials.md) and the
experiment's write-up.

## Reference

### Case file fields

| Field        | Type, default                                           | Meaning                                                                                              |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`         | lower-case letters, digits and `-`; required            | Must match the file name. What you type after `!case`.                                               |
| `title`      | text; required                                          | One line, shown in lists.                                                                            |
| `category`   | text; required                                          | The kind of failure probed, for grouping: `spatial-transformation`, `perception`, `coordinates`, ... |
| `hypothesis` | text; required                                          | What models will get wrong, and why.                                                                 |
| `gameMode`   | `creative`, `survival` or `any`; `any`                  | The agent's game mode. `!case` refuses an agent in the other mode.                                   |
| `scene`      | `flatten` or `existing`; `flatten`                      | Build the scene on flattened ground, or use the world as it is.                                      |
| `anchor`     | `[x, y, z]` world position; none                        | Ties the case to a place. Without it, the anchor is where you stand.                                 |
| `reset`      | `{ from, to }` offsets; none                            | A box put back to `<id>.baseline.json.gz` before every run.                                          |
| `requires`   | `{ negativeX }`; `{ negativeX: false }`                 | Refuse to run unless the anchor's x is negative.                                                     |
| `site`       | `{ radius: 2..24, height: 2..40 }`; radius 8, height 8  | The area a flattened scene replaces, and what the checks search for misplaced blocks.                |
| `owner`      | `{ at, facing }` or `null`; at `[0.5, 0, 0.5]`, `north` | Where you are put. `null` leaves you where you are.                                                  |
| `bot`        | `{ at }`; at `[-2.5, 0, 3.5]`                           | Where the bot starts.                                                                                |
| `setup`      | list of commands; `[]`                                  | Server commands, without the slash, that build the scene.                                            |
| `damage`     | list of commands; `[]`                                  | Commands run after the start is recorded, to damage the scene (for `restored` checks).               |
| `prompt`     | text; required                                          | The task, sent as if you had typed it.                                                               |
| `checks`     | list; `[]`                                              | Evaluated after every turn. A case passes when it has checks and all of them pass.                   |
| `watch`      | list of text; `[]`                                      | What to look for in the trace that the checks cannot see.                                            |
| `notes`      | text; `""`                                              | Anything else the person running the case should know.                                               |

Unknown fields are errors, so a typo is caught when the case is loaded.

### Checks

Every check may have a `label`, shown in results; without one, the lab writes a label from the check's settings. Block
names may use `*` as a wildcard (`*_fence`, or `*` for any block) and may be a list of accepted names. Air of any kind
and snow layers count as empty: snow falls on its own in snowy biomes.

#### block

The cell at an offset holds one of the given blocks, and, if `props` is given, those block-state values. When it does
not, the result says where in the site the wanted block was found instead, which catches off-by-one placements.

```yaml
- block: { at: [3, 0, 0], is: oak_stairs, props: { facing: east, half: bottom } }
```

#### count

The number of non-empty cells holding the given blocks in a box is `equals`, at least `min`, or at most `max` (one of
them is required; `min` and `max` may be combined).

```yaml
- count: { block: "*_fence", from: [-6, 0, -6], to: [6, 1, 6], min: 40 }
```

#### inventory

The bot holds at least `min` (default 1) of an item.

```yaml
- inventory: { item: wheat, min: 9 }
```

#### reply

The agent's final reply of the turn matches a regular expression, ignoring case.

```yaml
- reply: { matches: "\\b(4|four)\\s+windows?\\b" }
```

#### restored

For repairs. Every cell in the box that the `damage` commands changed is back to its state after `setup`, and no other
cell in the box changed. It fails when nothing was damaged.

```yaml
- restored: { from: [-3, 0, -3], to: [3, 4, 3] }
```

#### unchanged

No cell in the box differs from the scene as the agent was shown it. Use it to protect an original that the task
reads from, or anything the agent should leave alone.

```yaml
- unchanged: { from: [-21, 6, 3], to: [-15, 14, 15] }
```

#### copy

Every cell of the source box (`from`, `to`), air included, is reproduced somewhere else, with directional blocks
transformed too. The copy is:

- shifted by `offset`; or
- mirrored across the plane `axis` = `about` (an offset from the anchor; halves such as `-10.5` put the plane between
  two blocks), so east-facing stairs become west-facing, and then shifted by `offset`; or
- turned `rotate.clockwise` degrees (90, 180 or 270) seen from above, with the turned box's north-west bottom corner at
  `rotate.at`, so north-facing stairs become east-facing after a quarter turn.

A check mirrors or rotates, not both. The other options:

| Option             | Meaning                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `searchY`          | `[low, high]`: try every vertical offset in the range instead of `offset[1]`, and keep the best match.    |
| `ignore`           | Skip cells where the original or the copy holds one of these blocks, such as marker blocks.               |
| `ignoreProperties` | Block-state keys not compared, such as `axis` (wood grain direction), which the bot cannot always choose. |

The block-state keys compared are `facing`, `half`, `type` and `axis`, where the original has them; door hinges are
never compared. The result reports blocks right out of the original's blocks, extra blocks, cells that match, the
copy's floor height with `searchY`, and, for a mirror, how well an unmirrored copy in the same place would match. Its
metrics (`blocksRight`, `blocks`, `extraBlocks`, `groundCells`, `matching`, `total`, `wrongCells`, `bottomY`,
`plainMatching`) are what trial logs and summaries use. It fails when the source box is empty.

#### hidden

For line of sight. No part of any matching block within `within` blocks (horizontally) of where you stand, at heights
`y` (offsets from the anchor), can be seen from the eye point `eye` (your position plus 1.62 up): every line from the
eye to the block passes through a full, opaque block first. At least one matching block must be there.

```yaml
- hidden: { block: gold_block, eye: [0.5, 5.62, 0.5], within: 6, y: [0, 3] }
```

#### ring

At each height in `y`, the given blocks form a closed ring around `center` (`[dx, dz]`): every such block in the site
lies between `minRadius` and `maxRadius` from the centre, and nothing can walk from the centre to beyond the ring
without passing through a block (sideways moves only: two blocks that touch at a corner close the gap).

```yaml
- ring: { block: cobblestone_wall, center: [0, 0], y: [0, 0], minRadius: 4.5, maxRadius: 6.5 }
```

### How a copy is scored

For every cell of the source box, the checker computes where it lands in the copy and what should be there, and
compares that with what is there:

- **right**: the expected block, with the compared block-state values;
- **missing**: the copy's cell is empty where a block should be;
- **wrong**: another block, or the same block facing another way;
- **extra**: a block where the copy should be empty;
- **untouched ground**: a block where the copy should be empty, but the same block that was there before the agent
  started (or soil where soil was: grass under a new block turns to dirt by itself). A copy on a slope cannot avoid
  this, so these cells count neither as extra nor as wrong. The lab records every cell the copy may occupy, at every
  height `searchY` allows, when it sets the scene up.

With `searchY`, the height with the most matching cells is the copy's floor. The check passes when no cell is missing,
wrong or extra at that height.

The ground rule was added after the first mirror-hut trials. Trials logged before it can be scored again with
`npm run lab -- trials <case> --summary --rescore` ([docs/trials.md](trials.md#summaries-and-rescoring)).

## Testing a case

`npm test` loads every case file and fails when one is invalid, its `id` does not match its file name, or it has a
`reset` box without a recorded baseline (`tests/unit/configs.test.ts`). It needs no server.

To test a new kind of check, or a tricky scene, write a unit test like those in `tests/unit/case-checks.test.ts`: a
world held in a map, a case parsed with `CaseDefinitionSchema`, and `evaluateCase` with a scene record. Adding a check
type means a schema in `src/cases/case-definition.ts`, an evaluation in `src/cases/case-checks.ts`, and tests; see
[docs/architecture.md](architecture.md#extending-the-lab).

## Troubleshooting

| Message or symptom                                                                | Fix                                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Invalid config in configs/cases/<id>.yaml:` and a list of `- <field>: <problem>` | The file does not match the schema: an unknown key, a missing field, or a wrong type.               |
| `id "..." must match the file name`                                               | Rename the file or the id.                                                                          |
| `a count check needs equals, min or max`                                          | Add one of them.                                                                                    |
| `a copy check mirrors or rotates, not both`                                       | Split it into two checks, or drop one.                                                              |
| `Case <id> has no recorded baseline (...)`                                        | Record it: `npm run lab -- cases baseline <id> --from <checkpoint id>`.                             |
| `The baseline ... covers a different box than case <id>'s reset box`              | `anchor` or `reset` changed since the baseline was recorded; record it again.                       |
| `... has never been generated, so the baseline would be incomplete`               | Part of the reset box was never loaded in that world; visit it in game, save a new checkpoint.      |
| `Case <id> would replace everything from ... and that area looks built on`        | Move to open ground, or `!case <id> force`.                                                         |
| `Case <id> needs a <mode>-mode agent`                                             | Restart the lab with `--game-mode <mode>`.                                                          |
| `I need to see you to build the scene around you`                                 | Stand near the bot: a case without a fixed anchor is built where you stand.                         |
| `the server rejected "/<command>": ...`                                           | A setup or damage command is wrong; try it in chat as `/execute positioned <anchor> run <command>`. |
| `Cases need RCON to build their scene`                                            | Start the server and the lab with RCON; see [docs/setup.md](setup.md#rcon).                         |
