import { existsSync } from "node:fs";

import { readBaseline } from "../mcserver/region-baseline.ts";
import { LiveRegions, type RestoreReport } from "../mcserver/live-regions.ts";
import type { GameServices } from "../minecraft/game-services.ts";
import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import { boxFromCorners, type BlockPosition, type Box, type Position } from "../minecraft/types.ts";
import { sleep } from "../utils/abort.ts";
import { LabError } from "../utils/errors.ts";
import { baselineBoxOf, toBlockMap, type Baseline, type BlockMap } from "./case-checks.ts";
import { atOffset, COMMAND_YAW, fillTemplate, SITE_GROUND_DEPTH, type CaseDefinition } from "./case-definition.ts";
import type { SceneRecord } from "./case-checks.ts";

/** The case's fixed anchor, or the block the owner stands in. */
function anchorOf(definition: CaseDefinition, ownerPosition: Position | null): BlockPosition {
  if (definition.anchor !== undefined) {
    const [x, y, z] = definition.anchor;
    return { x, y, z };
  }
  if (ownerPosition === null) {
    throw new LabError(`Case ${definition.id} is built around you, and I cannot see you. Come closer and try again.`);
  }
  return { x: Math.floor(ownerPosition.x), y: Math.floor(ownerPosition.y), z: Math.floor(ownerPosition.z) };
}

/** A scene that is built and ready for the agent. */
export interface PreparedCase {
  readonly definition: CaseDefinition;
  readonly scene: SceneRecord;
  /** The task with coordinates filled in. */
  readonly prompt: string;
  /** Every command the runner sent and the server's reply, for the run directory. */
  readonly commands: readonly { readonly command: string; readonly reply: string }[];
}

/** Where a case's `reset` box is read from and restored to. */
export interface CaseResetSources {
  /** The server's world folder, read after the server writes it to disk. */
  readonly worldDir: string;
  /** The case's recorded baseline file. */
  readonly baselinePath: string;
}

/** Who is in the scene. */
export interface CaseCast {
  readonly owner: string;
  readonly bot: string;
}

/** `fill` refuses more than this many blocks per command. */
const MAX_FILL_BLOCKS = 32_768;
/** Time for block updates from the server to reach the bot before it records the scene. */
const SETTLE_MS = 1_500;
/** Server replies that mean a command did not run. Replies such as "No blocks were filled" are fine. */
const FAILED_REPLY =
  /Unknown or incomplete command|Incorrect argument|<--\[HERE\]|No player was found|not loaded|Too many blocks|Unknown (block|item)|Invalid|Failed to place|Unable to place|Could not find/i;
/** Blocks that rarely occur naturally: finding one in the site suggests someone built there. */
const BUILT_BLOCK =
  /planks|_stairs$|_slab$|_door$|_trapdoor$|_fence$|_fence_gate$|_wall$|glass|_bed$|chest$|barrel|crafting_table|furnace|smoker|torch|lantern|_wool$|_carpet$|bricks$|concrete|_sign$|bookshelf|ladder|_wood$|hay_block|anvil|_banner$|^cobblestone$/;

/**
 * Builds a case's scene around the owner through the server's operator channel.
 *
 * It replaces the site with flat ground, empties the bot's inventory, puts the owner and the bot in
 * their places, runs the case's setup commands, records the intended state of every box a `restored`
 * check covers, and then runs the damage commands. Every command runs positioned at the anchor, so a
 * case file's `~` coordinates are relative to it.
 */
export class CaseStage {
  readonly #server: ServerControl;
  readonly #game: GameServices;
  readonly #cast: CaseCast;
  readonly #reset: CaseResetSources | undefined;

  /**
   * @param server - The lab's RCON channel; cases cannot run without it.
   * @param game - The bot's view of the world, used to check the site and record baselines.
   * @param cast - The owner the scene is built around, and the bot that will do the task.
   * @param reset - Needed by cases with a `reset` box.
   */
  constructor(server: ServerControl, game: GameServices, cast: CaseCast, reset?: CaseResetSources) {
    this.#server = server;
    this.#game = game;
    this.#cast = cast;
    this.#reset = reset;
  }

  /**
   * Builds the scene for `definition` around its fixed anchor, or around `ownerPosition` when it has none.
   *
   * @param ownerPosition - Where the owner stands; needed only by cases without a fixed anchor.
   * @param force - Build even when the site seems to contain someone's buildings.
   * @throws LabError when RCON is missing, the anchor does not meet the case's requirements, the site
   *   holds built blocks (without `force`), or a command fails.
   */
  async prepare(definition: CaseDefinition, ownerPosition: Position | null, force: boolean): Promise<PreparedCase> {
    if (!this.#server.available) {
      throw new LabError('Cases need RCON to build their scene; see docs/setup.md, "RCON".');
    }
    const anchor = anchorOf(definition, ownerPosition);
    if (definition.requires.negativeX && anchor.x >= 0) {
      throw new LabError(
        `Case ${definition.id} needs a negative x coordinate (it probes rounding below zero). Stand somewhere with x < 0 (see F3) and run it again.`,
      );
    }
    const { radius, height } = definition.site;
    const site = boxFromCorners(atOffset(anchor, [-radius, -1, -radius]), atOffset(anchor, [radius, height, radius]));
    if (definition.scene === "flatten" && !force) {
      this.#refuseIfBuilt(site, definition.id);
    }

    const commands: { command: string; reply: string }[] = [];
    const run = async (list: readonly string[]): Promise<void> => {
      for (const template of list) {
        const command = fillTemplate(template, anchor, this.#cast);
        const reply = await this.#server.run(`execute positioned ${anchor.x} ${anchor.y} ${anchor.z} run ${command}`);
        commands.push({ command, reply });
        if (FAILED_REPLY.test(reply)) {
          throw new LabError(`Case ${definition.id}: the server rejected "/${command}": ${reply}`);
        }
      }
    };

    if (definition.reset !== undefined) {
      const report = await this.#resetArea(definition, anchor, definition.reset);
      commands.push({ command: `(reset: ${report.commands} commands from the baseline)`, reply: "" });
    }
    const flatten = definition.scene === "flatten" ? this.#flattenCommands(definition) : [];
    await run([...flatten, ...this.#placementCommands(definition), ...definition.setup]);
    await sleep(SETTLE_MS);
    const intended = this.#recordBaselineBoxes(definition, anchor);
    await run(definition.damage);
    if (definition.damage.length > 0) {
      await sleep(SETTLE_MS);
    }
    const presented = this.#recordBaselineBoxes(definition, anchor);
    const baselines = new Map<number, Baseline>();
    for (const [index, map] of intended) {
      baselines.set(index, { intended: map, presented: presented.get(index) ?? new Map() });
    }
    return {
      definition,
      scene: { anchor, baselines },
      prompt: fillTemplate(definition.prompt, anchor, this.#cast),
      commands,
    };
  }

  /** Puts the case's `reset` box back to its recorded baseline. */
  async #resetArea(
    definition: CaseDefinition,
    anchor: BlockPosition,
    reset: { from: [number, number, number]; to: [number, number, number] },
  ): Promise<RestoreReport> {
    if (this.#reset === undefined) {
      throw new LabError(`Case ${definition.id} resets an area, but the lab was not told where the world folder is.`);
    }
    const { baselinePath, worldDir } = this.#reset;
    if (!existsSync(baselinePath)) {
      throw new LabError(
        `Case ${definition.id} has no recorded baseline (${baselinePath}). Capture one from a checkpoint taken before any run: npm run lab -- cases baseline ${definition.id} --from <checkpoint id>`,
      );
    }
    const baseline = readBaseline(baselinePath);
    const box = boxFromCorners(atOffset(anchor, reset.from), atOffset(anchor, reset.to));
    if (JSON.stringify(baseline.box) !== JSON.stringify(box)) {
      throw new LabError(
        `The baseline ${baselinePath} covers a different box than case ${definition.id}'s reset box; capture it again.`,
      );
    }
    return new LiveRegions(this.#server, worldDir).restore(baseline);
  }

  /** Flat ground and no loose items across the site. */
  #flattenCommands(definition: CaseDefinition): string[] {
    const { radius: r, height } = definition.site;
    const layersPerFill = Math.max(1, Math.floor(MAX_FILL_BLOCKS / (2 * r + 1) ** 2));
    const commands: string[] = [];
    for (let bottom = 0; bottom <= height; bottom += layersPerFill) {
      const top = Math.min(height, bottom + layersPerFill - 1);
      commands.push(`fill ~-${r} ~${bottom} ~-${r} ~${r} ~${top} ~${r} air`);
    }
    commands.push(
      `fill ~-${r} ~-1 ~-${r} ~${r} ~-1 ~${r} grass_block`,
      `fill ~-${r} ~-${SITE_GROUND_DEPTH} ~-${r} ~${r} ~-2 ~${r} dirt`,
      `kill @e[type=item,distance=..${2 * r + 4}]`,
    );
    return commands;
  }

  /** An empty bot inventory, and the players in their places. */
  #placementCommands(definition: CaseDefinition): string[] {
    const [bx, by, bz] = definition.bot.at;
    const commands = ["clear {bot}", `tp {bot} ~${bx} ~${by} ~${bz}`];
    if (definition.owner !== null) {
      const [ox, oy, oz] = definition.owner.at;
      commands.push(`tp {owner} ~${ox} ~${oy} ~${oz} ${COMMAND_YAW[definition.owner.facing]} 0`);
    }
    return commands;
  }

  /**
   * The current blocks of every box a check compares with the scene's start, by check index: the box of a
   * `restored` or `unchanged` check, and every cell a `copy` check's copy may occupy.
   */
  #recordBaselineBoxes(definition: CaseDefinition, anchor: BlockPosition): Map<number, BlockMap> {
    const maps = new Map<number, BlockMap>();
    definition.checks.forEach((check, index) => {
      const box = baselineBoxOf(check, anchor);
      if (box !== null) {
        maps.set(index, toBlockMap(this.#game.scanner.snapshot(box).blocks));
      }
    });
    return maps;
  }

  #refuseIfBuilt(site: Box, caseId: string): void {
    const built: string[] = [];
    for (let y = site.min.y; y <= site.max.y && built.length < 3; y += 1) {
      for (let z = site.min.z; z <= site.max.z && built.length < 3; z += 1) {
        for (let x = site.min.x; x <= site.max.x && built.length < 3; x += 1) {
          const block = this.#game.scanner.blockAt({ x, y, z });
          if (block !== null && BUILT_BLOCK.test(block.name)) {
            built.push(`${block.name} at (${x}, ${y}, ${z})`);
          }
        }
      }
    }
    if (built.length > 0) {
      throw new LabError(
        `Case ${caseId} would replace everything from (${site.min.x}, ${site.min.y}, ${site.min.z}) to (${site.max.x}, ${site.max.y}, ${site.max.z}), and that area looks built on (${built.join(", ")}). Move to open ground, or run "!case ${caseId} force" to replace it anyway.`,
      );
    }
  }
}
