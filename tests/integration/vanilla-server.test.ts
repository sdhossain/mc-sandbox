/**
 * Integration tests against a real vanilla 1.21.11 server, started in a temporary folder.
 *
 * They download Mojang's server jar (or copy it from MCLAB_SERVER_JAR) and write `eula=true`, so they
 * run only when MCLAB_ACCEPT_EULA=1 is set by someone who agrees to the Minecraft EULA:
 *
 *   MCLAB_ACCEPT_EULA=1 npm run test:integration
 *
 * Setting MCLAB_LIVE_MODEL to a preset id from configs/models.yaml (for example gpt-6-luna) also runs one
 * real turn on the primitive harness and one on the code harness with that model. It calls the
 * provider's API with the key from .env and costs a few cents at most (each turn is capped at $0.25).
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBot, type Bot } from "mineflayer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import "../../src/harness/index.ts";
import "../../src/llm/index.ts";
import { evaluateCase, summariseResult, type CaseResult, type CaseWorld } from "../../src/cases/case-checks.ts";
import { CaseLibrary } from "../../src/cases/case-library.ts";
import { CaseStage, type PreparedCase } from "../../src/cases/case-stage.ts";
import { TrialLog } from "../../src/cases/trial-log.ts";
import { AUTO_REPLY, TrialRunner } from "../../src/cases/trial-runner.ts";
import { LabConfigSchema } from "../../src/config/lab-config.ts";
import { loadModelCatalog } from "../../src/config/load-config.ts";
import { Lab } from "../../src/lab/lab.ts";
import { ScriptedModelConfigSchema } from "../../src/llm/scripted/scripted-model.ts";
import { JavaLocator } from "../../src/mcserver/java-locator.ts";
import { ServerInstaller } from "../../src/mcserver/server-installer.ts";
import { ServerProcess } from "../../src/mcserver/server-process.ts";
import { ServerProperties } from "../../src/mcserver/server-properties.ts";
import { WorldCheckpointer } from "../../src/mcserver/world-checkpointer.ts";
import { AnvilReader } from "../../src/mcserver/anvil-reader.ts";
import { captureBaseline, readBaseline, stateString } from "../../src/mcserver/region-baseline.ts";
import { LiveRegions, restoreCommands } from "../../src/mcserver/live-regions.ts";
import { BotConnection } from "../../src/minecraft/bot-connection.ts";
import { isOccludingBlock } from "../../src/minecraft/names.ts";
import type { GameServices } from "../../src/minecraft/game-services.ts";
import { RconServerControl } from "../../src/minecraft/server-control/rcon-server-control.ts";
import type { BlockPosition } from "../../src/minecraft/types.ts";
import { SkillLibrary } from "../../src/skills/skill-library.ts";
import type { LabEvent } from "../../src/observability/events.ts";
import { sleep } from "../../src/utils/abort.ts";

const enabled = process.env.MCLAB_ACCEPT_EULA === "1";
const liveModel = process.env.MCLAB_LIVE_MODEL;

/** Returns `value`, failing the test with a clear message when setup did not produce it. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} was not set up`);
  }
  return value;
}
/** Connects a bot that plays the owner, and resolves once it has spawned. */
async function connectOwner(port: number, username = "Tester"): Promise<Bot> {
  const bot = createBot({ host: "127.0.0.1", port, username, version: "1.21.11", auth: "offline" });
  await new Promise<void>((resolve) =>
    bot.once("spawn", () => {
      resolve();
    }),
  );
  return bot;
}

/** Setblock commands for a midpoint circle of `radius` around the anchor, at each height in `heights`. */
function circleCommands(radius: number, heights: readonly number[], block: string): string[] {
  const cells = new Set<string>();
  for (let x = 0, z = radius, error = 1 - radius; x <= z; x += 1) {
    for (const [a, b] of [
      [x, z],
      [z, x],
      [-x, z],
      [-z, x],
      [x, -z],
      [z, -x],
      [-x, -z],
      [-z, -x],
    ] as const) {
      cells.add(`${a},${b}`);
    }
    if (error < 0) {
      error += 2 * x + 3;
    } else {
      error += 2 * (x - z) + 5;
      z -= 1;
    }
  }
  return heights.flatMap((y) =>
    [...cells].map((cell) => {
      const [dx, dz] = cell.split(",");
      return `setblock ~${dx} ~${y} ~${dz} ${block}`;
    }),
  );
}

/** The case checks' view of the world, through a bot. */
function caseWorld(game: GameServices): CaseWorld {
  return {
    blockAt: (position) => game.scanner.blockAt(position),
    inventoryCount: (item) => game.inventory.count(item),
    isOccluder: (name) => isOccludingBlock(game.mcData, name),
  };
}

const VERSION = "1.21.11";
const PORT = 25591;
const RCON_PORT = 25592;

describe.skipIf(!enabled)("vanilla 1.21.11 server", () => {
  const directory = mkdtempSync(join(tmpdir(), "mclab-server-"));
  const runsDir = mkdtempSync(join(tmpdir(), "mclab-runs-"));
  let server: ServerProcess | undefined;
  let rcon: RconServerControl | undefined;

  beforeAll(async () => {
    const cachedJar = process.env.MCLAB_SERVER_JAR;
    if (cachedJar !== undefined && existsSync(cachedJar)) {
      copyFileSync(cachedJar, join(directory, "server.jar"));
    }
    await new ServerInstaller({
      directory,
      version: VERSION,
      operators: ["Tester"],
      acceptEula: true,
      flat: true,
      port: PORT,
      rconPort: RCON_PORT,
    }).setup();
    const java = new JavaLocator().find();
    if (java === null) {
      throw new Error("Java 21 is required for the integration tests");
    }
    server = new ServerProcess({ directory, javaPath: java.path, memory: "2G" });
    await server.start();
    const password = ServerProperties.read(join(directory, "server.properties")).get("rcon.password") ?? "";
    rcon = await RconServerControl.connect("127.0.0.1", RCON_PORT, password);
    await rcon.run("gamerule doDaylightCycle false");
    await rcon.run("time set day");
  }, 240_000);

  afterAll(async () => {
    await rcon?.close();
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }, 60_000);

  describe("game layer", () => {
    let connection: BotConnection | undefined;
    let game: GameServices;
    let origin: BlockPosition;

    beforeAll(async () => {
      connection = new BotConnection(
        { host: "127.0.0.1", port: PORT, username: "Builder", version: VERSION, reconnect: false },
        () => undefined,
      );
      game = await connection.connect();
      await required(rcon, "rcon").setGameMode("Builder", "creative");
      await sleep(1_000);
      const feet = game.scanner.status().position;
      origin = { x: Math.floor(feet.x) + 2, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    }, 60_000);

    afterAll(async () => {
      await connection?.close();
    });

    it("places a block, reads it back, and records the change as the bot's", async () => {
      const before = game.changes.lastSeq();
      const result = await game.placer.place(origin, "oak_planks");
      expect(result.block.name).toBe("oak_planks");
      expect(game.scanner.blockAt(origin)?.name).toBe("oak_planks");
      await sleep(200);
      const changes = game.changes.since(before);
      expect(
        changes.some(
          (change) => change.position.x === origin.x && change.after.name === "oak_planks" && change.cause === "bot",
        ),
      ).toBe(true);
    });

    it("reports a block that is already there instead of failing", async () => {
      const result = await game.placer.place(origin, "oak_planks");
      expect(result.alreadyPresent).toBe(true);
    });

    it("places stairs facing the requested direction", async () => {
      const target = { ...origin, z: origin.z + 2 };
      const result = await game.placer.place(target, "oak_stairs", { facing: "east" });
      expect(result.block.name).toBe("oak_stairs");
      expect(result.block.properties.facing).toBe("east");
    });

    it("digs a block", async () => {
      const result = await game.breaker.dig(origin);
      expect(result.broken.name).toBe("oak_planks");
      expect(game.scanner.blockAt(origin)?.name).toBe("air");
    });

    it("tills grass with a hoe and plants seeds", async () => {
      const ground = { x: origin.x + 1, y: origin.y - 1, z: origin.z - 2 };
      expect(game.scanner.blockAt(ground)?.name).toBe("grass_block");
      const tilled = await game.interactor.useItemOn(ground, "wooden_hoe");
      expect(tilled.name).toBe("farmland");
      await game.interactor.useItemOn(ground, "wheat_seeds");
      await sleep(300);
      expect(game.scanner.blockAt({ ...ground, y: ground.y + 1 })?.name).toBe("wheat");
    });

    it("renders a region with absolute coordinates", () => {
      const text = game.renderer.render({
        min: { ...origin, y: origin.y - 1 },
        max: { x: origin.x + 2, y: origin.y, z: origin.z + 2 },
      });
      expect(text).toContain(`y=${origin.y - 1}`);
      expect(text).toContain("grass_block");
    });

    it("keeps walking after a stop while idle and after a failed walk", async () => {
      // A stop requested while standing still used to cancel every later walk (pathfinder 2.4.5 latches it).
      game.navigator.stop();
      game.bot.pathfinder.stop();
      const back = await game.navigator.goTo(
        { x: origin.x - 2, y: origin.y, z: origin.z + 3 },
        { range: 1, timeoutMs: 30_000 },
      );
      expect(back.distance).toBeLessThanOrEqual(2);
      await expect(
        game.navigator.goTo({ x: origin.x, y: origin.y + 12, z: origin.z }, { range: 0, timeoutMs: 8_000 }),
      ).rejects.toThrow(/Walking to/);
      const after = await game.navigator.goTo(
        { x: origin.x + 2, y: origin.y, z: origin.z + 3 },
        { range: 1, timeoutMs: 30_000 },
      );
      expect(after.distance).toBeLessThanOrEqual(2);
    }, 90_000);

    it("gathers dirt in survival by digging grass and picking up the drops", async () => {
      const server = required(rcon, "rcon");
      await server.setGameMode("Builder", "survival");
      await sleep(500);
      try {
        const before = game.inventory.count("dirt");
        const report = await new SkillLibrary(game, { progress: () => undefined }).collectBlocks("dirt", 3, 16);
        expect(game.inventory.count("dirt") - before).toBeGreaterThanOrEqual(3);
        expect(report.blocksDug).toBeLessThanOrEqual(5);
      } finally {
        await server.setGameMode("Builder", "creative");
      }
    }, 120_000);

    it("walks to a position", async () => {
      const target = { x: origin.x + 6, y: origin.y, z: origin.z };
      const result = await game.navigator.goTo(target, { range: 1, timeoutMs: 30_000 });
      expect(result.distance).toBeLessThanOrEqual(2);
    });

    it("places ladders against a wall, not on the ground", async () => {
      const server = required(rcon, "rcon");
      const { x, y, z } = { ...origin, x: origin.x - 6, z: origin.z + 8 };
      // A one-block shaft with walls on three sides, open to the west where the bot stands.
      await server.run(`fill ${x} ${y} ${z - 1} ${x + 1} ${y + 2} ${z + 1} stone`);
      await server.run(`fill ${x} ${y} ${z} ${x} ${y + 2} ${z} air`);
      await sleep(500);
      const first = await game.placer.place({ x, y, z }, "ladder");
      const second = await game.placer.place({ x, y: y + 1, z }, "ladder", { facing: "west" });
      expect(first.block.name).toBe("ladder");
      expect(second.block.name).toBe("ladder");
      expect(second.block.properties.facing).toBe("west");
    });
  });

  describe("lab with a scripted model", () => {
    let lab: Lab | undefined;
    let owner: Bot | undefined;
    const replies: string[] = [];

    beforeAll(async () => {
      const tester = createBot({
        host: "127.0.0.1",
        port: PORT,
        username: "Tester",
        version: VERSION,
        auth: "offline",
      });
      owner = tester;
      await new Promise<void>((resolve) =>
        tester.once("spawn", () => {
          resolve();
        }),
      );
      tester.on("chat", (username, message) => {
        if (username === "Sol") {
          replies.push(message);
        }
      });
      await sleep(1_000);
      const at = tester.entity.position.floored();
      const target = { x: at.x + 2, y: at.y, z: at.z + 1 };
      const model = ScriptedModelConfigSchema.parse({
        id: "scripted-test",
        provider: "scripted",
        model: "scripted",
        pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 },
        script: [
          {
            text: "Placing.",
            calls: [{ name: "place_block", arguments: { ...target, item: "stone", facing: null, half: null } }],
          },
          {
            calls: [
              {
                name: "inspect_region",
                arguments: {
                  x1: target.x - 1,
                  y1: target.y,
                  z1: target.z - 1,
                  x2: target.x + 1,
                  y2: target.y,
                  z2: target.z + 1,
                },
              },
            ],
          },
          { text: `Placed stone at ${target.x} ${target.y} ${target.z}.` },
        ],
      });
      const config = LabConfigSchema.parse({
        checkpoints: { enabled: false },
        server: { port: PORT, directory },
        owners: ["Tester"],
        runsDir,
        dashboard: { enabled: false },
        agents: [{ name: "Sol", model: "scripted-test", harness: "primitive", privileges: { gameMode: "creative" } }],
      });
      lab = await Lab.open(config, { models: new Map([["scripted-test", model]]) });
      await lab.start();
      await sleep(1_500);
    }, 90_000);

    afterAll(async () => {
      await lab?.shutdown();
      owner?.quit();
    });

    it("takes a task from chat, acts, replies, and records the run", async () => {
      required(owner, "owner bot").chat("place a stone block");
      const deadline = Date.now() + 60_000;
      while (!replies.some((reply) => reply.startsWith("Placed stone")) && Date.now() < deadline) {
        await sleep(250);
      }
      expect(replies.some((reply) => reply.startsWith("Placed stone"))).toBe(true);
      await sleep(1_500);

      const [runId] = readdirSync(runsDir);
      expect(runId).toBeDefined();
      const runDir = join(runsDir, runId ?? "");
      const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
      const types = events.map((event) => event.type);
      expect(types).toContain("run.started");
      expect(types).toContain("turn.started");
      expect(events.find((event) => event.type === "tool.finished" && event.data.name === "place_block")?.data.ok).toBe(
        true,
      );
      expect(events.find((event) => event.type === "turn.ended")?.data.status).toBe("completed");
      expect(readdirSync(join(runDir, "snapshots")).some((file) => file.endsWith(".after.json"))).toBe(true);
      expect(readFileSync(join(runDir, "transcript.md"), "utf8")).toContain("place_block");
    }, 90_000);

    it("runs a failure case from chat: builds the scene, sends the task, records the result", async () => {
      // "force": earlier tests built next to spawn, and a case refuses to clear a site that looks built on.
      required(owner, "owner bot").chat("!case mirror-shed force");
      const deadline = Date.now() + 60_000;
      const resultFile = (): string | undefined => {
        for (const run of readdirSync(runsDir)) {
          const file = join(runsDir, run, "case-result-turn-001.json");
          if (existsSync(file)) {
            return file;
          }
        }
        return undefined;
      };
      while (resultFile() === undefined && Date.now() < deadline) {
        await sleep(250);
      }
      expect(replies.find((reply) => reply.includes("mirror-shed"))).toMatch(/^Case mirror-shed/);
      const result = JSON.parse(readFileSync(required(resultFile(), "case result"), "utf8")) as CaseResult;
      // The scripted model places one stone block, not a mirrored shed.
      expect(result.caseId).toBe("mirror-shed");
      expect(result.passed).toBe(false);
      expect(result.checks[0]?.detail).toMatch(/cells match/);
    }, 90_000);

    it("runs a case as an unattended trial, saves its end state, and !load puts that back", async () => {
      const theLab = required(lab, "lab");
      const agent = required(theLab.agent("Sol"), "agent Sol");
      // mirror-shed is a creative case like this lab's bot; "force" because earlier tests built near spawn.
      const record = await new TrialRunner(agent, theLab.bus, {
        caseId: "mirror-shed",
        owner: "Tester",
        force: true,
      }).run(1);
      expect(record.status).toBe("completed");
      expect(record.passed).toBe(false);
      expect(record.runId).toBe(agent.runId);
      expect(record.anchor).not.toBeNull();
      expect(record.checks[0]?.metrics?.blocks).toBeGreaterThan(0);
      expect(record.steps).toBeGreaterThan(0);

      // Save the end state as the trials command does, then change the area.
      const stateId = TrialLog.nextStateId(runsDir);
      const stateFile = await theLab.states.save(record);
      new TrialLog(runsDir, "mirror-shed").append({ ...record, stateId, stateFile, checkpoint: null });
      const saved = readBaseline(stateFile);
      const { min } = saved.box;
      const server = required(rcon, "rcon");
      await server.run(`fill ${min.x} ${min.y + 4} ${min.z} ${min.x + 3} ${min.y + 5} ${min.z + 3} gold_block`);

      required(owner, "owner bot").chat(`!load ${stateId}`);
      const deadline = Date.now() + 30_000;
      while (!replies.some((reply) => reply.startsWith(`Loaded ${stateId}`)) && Date.now() < deadline) {
        await sleep(250);
      }
      expect(replies.find((reply) => reply.startsWith(`Loaded ${stateId}`))).toMatch(
        /mirror-shed, scripted-test trial 1, FAIL/,
      );
      await server.run("save-all flush");
      const world = new AnvilReader(join(directory, "world"));
      expect(restoreCommands(saved, (position) => world.blockAt(position))).toEqual([]);
    }, 120_000);
  });

  describe("trials whose model stops to ask", () => {
    let lab: Lab | undefined;
    let owner: Bot | undefined;
    const question = "The site has buildings on it. Should I build over them?";

    beforeAll(async () => {
      owner = await connectOwner(PORT);
      await sleep(1_000);
      // A model that answers every message with the same question and nothing else.
      const model = ScriptedModelConfigSchema.parse({
        id: "scripted-asker",
        provider: "scripted",
        model: "scripted",
        pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 },
        script: [{ text: question }],
      });
      const config = LabConfigSchema.parse({
        checkpoints: { enabled: false },
        server: { port: PORT, directory },
        owners: ["Tester"],
        runsDir,
        dashboard: { enabled: false },
        agents: [{ name: "Sol", model: "scripted-asker", harness: "primitive", privileges: { gameMode: "creative" } }],
      });
      lab = await Lab.open(config, { models: new Map([["scripted-asker", model]]) });
      await lab.start();
      await sleep(1_500);
    }, 90_000);

    afterAll(async () => {
      await lab?.shutdown();
      owner?.quit();
    });

    it("answers the question once in the owner's name, then records the trial with both turns", async () => {
      const theLab = required(lab, "lab");
      const agent = required(theLab.agent("Sol"), "agent Sol");
      const record = await new TrialRunner(agent, theLab.bus, {
        caseId: "mirror-shed",
        owner: "Tester",
        force: true,
      }).run(1);
      // The model asks again after the answer, and the trial does not answer twice.
      expect(record.autoReplies).toEqual([{ turn: 1, question, reply: AUTO_REPLY }]);
      expect(record).toMatchObject({ passed: false, status: "completed", steps: 2, finalText: question });

      const runDir = join(runsDir, record.runId);
      expect(existsSync(join(runDir, "case-result-turn-002.json"))).toBe(true);
      const turns = readFileSync(join(runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as LabEvent)
        .flatMap((event) => (event.type === "turn.started" ? [event.data] : []));
      expect(turns.map((turn) => [turn.source, turn.from])).toEqual([
        ["case", "Tester"],
        ["trial", "Tester"],
      ]);
      expect(turns[1]?.message).toBe(AUTO_REPLY);
      expect(readFileSync(join(runDir, "transcript.md"), "utf8")).toContain("Tester (trial)");
    }, 120_000);
  });

  describe("failure cases", () => {
    const library = CaseLibrary.load("configs/cases");
    /** A correct answer for each case with checks, to prove the checks can pass: commands at the anchor, and a reply. */
    const solutions: Readonly<Record<string, { commands: readonly string[]; reply?: string }>> = {
      "mirror-shed": {
        commands: [
          "fill ~4 ~ ~-9 ~4 ~2 ~-9 spruce_planks",
          "fill ~8 ~ ~-9 ~8 ~2 ~-9 spruce_planks",
          "fill ~4 ~ ~-5 ~4 ~2 ~-5 spruce_planks",
          "fill ~8 ~ ~-5 ~8 ~2 ~-5 spruce_planks",
          "fill ~5 ~ ~-9 ~7 ~2 ~-9 oak_planks",
          "fill ~5 ~ ~-5 ~7 ~2 ~-5 oak_planks",
          "fill ~8 ~ ~-8 ~8 ~2 ~-6 oak_planks",
          "fill ~4 ~ ~-8 ~4 ~2 ~-6 oak_planks",
          "setblock ~4 ~ ~-7 oak_door[facing=west,half=lower,hinge=right]",
          "setblock ~4 ~1 ~-7 oak_door[facing=west,half=upper,hinge=right]",
          "setblock ~8 ~1 ~-7 glass",
          "setblock ~6 ~1 ~-9 glass",
          "fill ~4 ~3 ~-9 ~8 ~3 ~-5 oak_planks",
          "fill ~7 ~4 ~-8 ~7 ~5 ~-8 cobblestone",
          "setblock ~3 ~ ~-7 oak_stairs[facing=east]",
          "setblock ~6 ~ ~-4 oak_stairs[facing=north]",
        ],
      },
      "rotate-shed": {
        commands: [
          "fill ~9 ~ ~-12 ~9 ~2 ~-12 spruce_planks",
          "fill ~13 ~ ~-12 ~13 ~2 ~-12 spruce_planks",
          "fill ~9 ~ ~-8 ~9 ~2 ~-8 spruce_planks",
          "fill ~13 ~ ~-8 ~13 ~2 ~-8 spruce_planks",
          "fill ~10 ~ ~-12 ~12 ~2 ~-12 oak_planks",
          "fill ~10 ~ ~-8 ~12 ~2 ~-8 oak_planks",
          "fill ~9 ~ ~-11 ~9 ~2 ~-9 oak_planks",
          "fill ~13 ~ ~-11 ~13 ~2 ~-9 oak_planks",
          "setblock ~11 ~ ~-12 oak_door[facing=north,half=lower,hinge=left]",
          "setblock ~11 ~1 ~-12 oak_door[facing=north,half=upper,hinge=left]",
          "setblock ~11 ~1 ~-8 glass",
          "setblock ~9 ~1 ~-10 glass",
          "fill ~9 ~3 ~-12 ~13 ~3 ~-8 oak_planks",
          "fill ~10 ~4 ~-9 ~10 ~5 ~-9 cobblestone",
          "setblock ~11 ~ ~-13 oak_stairs[facing=south]",
          "setblock ~14 ~ ~-10 oak_stairs[facing=west]",
        ],
      },
      // Encased in stone on every side and on top, 2 blocks east and 2 north of the pillar.
      "hide-gold": { commands: ["fill ~1 ~ ~-1 ~3 ~1 ~1 stone", "setblock ~2 ~ ~ gold_block"] },
      "round-wall": { commands: circleCommands(6, [0, 1], "stone") },
      "count-windows": { commands: [], reply: "I count 11 windows: 33 glass blocks in 11 separate groups." },
      "lookout-tower": {
        commands: [
          "fill ~-1 ~ ~-7 ~1 ~6 ~-5 cobblestone",
          "fill ~ ~ ~-6 ~ ~6 ~-6 ladder[facing=north]",
          "fill ~1 ~ ~-6 ~1 ~1 ~-6 air",
          "fill ~-2 ~7 ~-8 ~2 ~7 ~-4 oak_planks",
          "setblock ~ ~7 ~-6 ladder[facing=north]",
          "fill ~-2 ~8 ~-8 ~2 ~8 ~-8 oak_fence",
          "fill ~-2 ~8 ~-4 ~2 ~8 ~-4 oak_fence",
          "fill ~-2 ~8 ~-7 ~-2 ~8 ~-5 oak_fence",
          "fill ~2 ~8 ~-7 ~2 ~8 ~-5 oak_fence",
        ],
      },
    };
    let caseOwner: Bot | undefined;
    let connection: BotConnection | undefined;
    let game: GameServices;
    const prepared = new Map<string, PreparedCase>();

    beforeAll(async () => {
      caseOwner = await connectOwner(PORT, "CaseOwner");
      connection = new BotConnection(
        { host: "127.0.0.1", port: PORT, username: "CaseBot", version: VERSION, reconnect: false },
        () => undefined,
      );
      game = await connection.connect();
    }, 60_000);

    afterAll(async () => {
      caseOwner?.quit();
      await connection?.close();
    });

    /** Moves both players to a fresh spot for case `index`, far from the others, and returns the owner's position. */
    async function goToSite(index: number): Promise<{ x: number; y: number; z: number }> {
      const server = required(rcon, "rcon");
      const x = -100 - 80 * index;
      await server.run(`tp CaseOwner ${x + 0.5} -60 -99.5`);
      await server.run(`tp CaseBot ${x - 2.5} -60 -96.5`);
      await sleep(2_500);
      const position = required(caseOwner, "case owner").entity.position;
      return { x: position.x, y: position.y, z: position.z };
    }

    it.each(library.list().map((definition, index) => [definition.id, index] as const))(
      "builds the %s scene with no rejected commands, and its checks fail until someone acts",
      async (id, index) => {
        const definition = library.get(id);
        const at = await goToSite(index);
        const stage = new CaseStage(
          required(rcon, "rcon"),
          game,
          { owner: "CaseOwner", bot: "CaseBot" },
          {
            worldDir: join(directory, "world"),
            baselinePath: library.baselinePath(id),
          },
        );
        const ready = await stage.prepare(definition, at, false);
        prepared.set(id, ready);
        const result = evaluateCase(definition, ready.scene, caseWorld(game), "", 1);
        console.log(`${summariseResult(result)}\n  prompt: ${ready.prompt}`);
        expect(result.passed).toBe(false);
      },
      60_000,
    );

    it.each(Object.keys(solutions))(
      "passes %s when it is solved correctly",
      async (id) => {
        const ready = required(prepared.get(id), `prepared ${id}`);
        const { x, y, z } = ready.scene.anchor;
        const server = required(rcon, "rcon");
        await server.run(`tp CaseBot ${x - 2.5} ${y} ${z + 3.5}`);
        await sleep(2_500); // the server reloads the area's chunks around the bot before commands can reach them
        const solution = solutions[id] ?? { commands: [] };
        for (const command of solution.commands) {
          const reply = await server.run(`execute positioned ${x} ${y} ${z} run ${command}`);
          expect(reply).not.toMatch(/Unknown|Incorrect|HERE|not loaded/);
        }
        await sleep(2_000);
        const result = evaluateCase(ready.definition, ready.scene, caseWorld(game), solution.reply ?? "", 1);
        console.log(summariseResult(result));
        expect(summariseResult(result)).toMatch(/PASS/);
      },
      30_000,
    );

    it("refuses to build over a site that looks built on, unless forced", async () => {
      const shed = required(prepared.get("mirror-shed"), "mirror-shed scene").scene.anchor;
      const stage = new CaseStage(required(rcon, "rcon"), game, { owner: "CaseOwner", bot: "CaseBot" });
      const position = { x: shed.x + 0.5, y: shed.y, z: shed.z + 0.5 };
      await required(rcon, "rcon").run(`tp CaseBot ${shed.x - 2.5} ${shed.y} ${shed.z + 3.5}`);
      await sleep(1_500);
      await expect(stage.prepare(library.get("sheep-pen"), position, false)).rejects.toThrow(/looks built on/);
    }, 30_000);
  });

  describe("area resets", () => {
    it("puts a recorded area back, even where no player is near", async () => {
      const server = required(rcon, "rcon");
      const store = mkdtempSync(join(tmpdir(), "mclab-reset-checkpoints-"));
      const area = { min: { x: 499, y: -61, z: 499 }, max: { x: 505, y: -56, z: 505 } };
      // Build something in an area far from every player, then record it from a checkpoint.
      await server.run("forceload add 499 499 505 505");
      for (const command of [
        "fill 500 -60 500 504 -58 504 oak_planks hollow",
        "setblock 502 -60 500 oak_door[half=lower,facing=north] strict",
        "setblock 502 -59 500 oak_door[half=upper,facing=north] strict",
        "setblock 502 -60 502 torch strict",
        "setblock 503 -57 502 oak_stairs[facing=east,half=top]",
      ]) {
        expect(await server.run(command)).not.toMatch(/Unknown|Incorrect|HERE|not loaded/);
      }
      const checkpoint = await new WorldCheckpointer(server, join(directory, "world"), store).save("reset test");
      const recorded = new AnvilReader(checkpoint.worldPath);
      const baseline = captureBaseline(area, (position) => recorded.blockAt(position), "test checkpoint");
      expect(stateString(recorded.blockAt({ x: 503, y: -57, z: 502 }) ?? { name: "?", properties: {} })).toMatch(
        /^oak_stairs\[facing=east,half=top/,
      );
      // Damage it, then let the chunks unload.
      for (const command of [
        "fill 500 -60 500 504 -58 500 air",
        "setblock 502 -60 502 cobblestone",
        "setblock 499 -60 499 gold_block",
        "setblock 503 -57 502 air",
      ]) {
        await server.run(command);
      }
      await server.run("forceload remove 499 499 505 505");
      await sleep(2_000);

      const report = await new LiveRegions(server, join(directory, "world")).restore(baseline);
      expect(report.commands).toBeGreaterThan(0);
      // Read the world back from disk: every cell must equal the recording.
      await server.run("save-all flush");
      const restored = new AnvilReader(join(directory, "world"));
      expect(restoreCommands(baseline, (position) => restored.blockAt(position))).toEqual([]);
    }, 90_000);
  });

  describe("world checkpoints", () => {
    it("saves a complete world copy, then shares unchanged files with the next one", async () => {
      const server = required(rcon, "rcon");
      const store = mkdtempSync(join(tmpdir(), "mclab-checkpoints-"));
      const checkpoints = new WorldCheckpointer(server, join(directory, "world"), store);
      const first = await checkpoints.save("first");
      expect(existsSync(join(first.worldPath, "level.dat"))).toBe(true);
      expect(readdirSync(join(first.worldPath, "region")).some((file) => file.endsWith(".mca"))).toBe(true);
      expect(first.gameTime).toBeGreaterThan(0);
      await server.run("setblock 3 -60 3 gold_block");
      const second = await checkpoints.save("second");
      expect(second.copiedBytes).toBeGreaterThan(0);
      expect(second.linkedBytes).toBeGreaterThan(0);
      console.log(
        `checkpoints: first ${first.copiedBytes} bytes in ${first.durationMs} ms; second ${second.copiedBytes} copied, ${second.linkedBytes} shared, ${second.durationMs} ms`,
      );
    }, 60_000);
  });

  describe.skipIf(liveModel === undefined)(`live model ${liveModel ?? ""}`, () => {
    let lab: Lab | undefined;
    let owner: Bot | undefined;
    const events: LabEvent[] = [];
    const liveRunsDir = mkdtempSync(join(tmpdir(), "mclab-live-runs-"));
    const budget = { maxStepsPerTurn: 25, maxTurnMinutes: 4, maxTurnCostUsd: 0.25, maxRunCostUsd: 0.5 };

    beforeAll(async () => {
      if (existsSync(".env")) {
        process.loadEnvFile(".env");
      }
      owner = await connectOwner(PORT);
      await sleep(1_000);
      const config = LabConfigSchema.parse({
        checkpoints: { enabled: false },
        server: { port: PORT, directory },
        owners: ["Tester"],
        runsDir: liveRunsDir,
        dashboard: { enabled: false },
        agents: [
          { name: "Prim", model: liveModel, harness: "primitive", privileges: { gameMode: "creative" }, budget },
          { name: "Coder", model: liveModel, harness: "code", privileges: { gameMode: "creative" }, budget },
        ],
      });
      lab = await Lab.open(config, { models: loadModelCatalog() });
      lab.bus.subscribe((event) => events.push(event));
      await lab.start();
      await sleep(1_500);
      console.log(`live runs: ${liveRunsDir}`);
    }, 120_000);

    afterAll(async () => {
      await lab?.shutdown();
      owner?.quit();
    });

    /** Sends `text` as the owner and waits for that agent's turn to end. */
    async function runTask(agent: string, text: string): Promise<LabEvent[]> {
      const start = events.length;
      required(owner, "owner bot").chat(`${agent}, ${text}`);
      const deadline = Date.now() + 5 * 60_000;
      const ended = (): boolean => events.slice(start).some((e) => e.agent === agent && e.type === "turn.ended");
      while (!ended() && Date.now() < deadline) {
        await sleep(500);
      }
      const turn = events.slice(start).filter((event) => event.agent === agent);
      const end = turn.find((event) => event.type === "turn.ended");
      if (end?.type === "turn.ended") {
        console.log(
          `${agent}: ${end.data.status}, ${end.data.totals.steps} steps, $${end.data.totals.costUsd.toFixed(4)}: ${end.data.finalText}`,
        );
      }
      return turn;
    }

    it("completes a one-block task on the primitive harness", async () => {
      const turn = await runTask(
        "Prim",
        "place one oak_planks block two blocks east of where I stand, at my feet level.",
      );
      const end = turn.find((event) => event.type === "turn.ended");
      expect(end?.type === "turn.ended" && end.data.status).toBe("completed");
      expect(turn.some((event) => event.type === "model.response")).toBe(true);
      expect(turn.some((e) => e.type === "tool.finished" && e.data.name === "place_block" && e.data.ok)).toBe(true);
    }, 360_000);

    it("runs model-written code on the code harness", async () => {
      const turn = await runTask(
        "Coder",
        "use run_code to place a row of 3 stone blocks starting 3 blocks south of me, going east, at my feet level.",
      );
      const end = turn.find((event) => event.type === "turn.ended");
      expect(end?.type === "turn.ended" && end.data.status).toBe("completed");
      expect(turn.some((e) => e.type === "tool.finished" && e.data.name === "run_code" && e.data.ok)).toBe(true);
    }, 360_000);
  });

  describe("item requests with approval", () => {
    let lab: Lab | undefined;
    let approver: Bot | undefined;
    const events: LabEvent[] = [];
    const questions: string[] = [];

    beforeAll(async () => {
      const owner = await connectOwner(PORT, "Approver");
      approver = owner;
      owner.on("chat", (username, message) => {
        if (username === "Asker") {
          questions.push(message);
        }
      });
      const model = ScriptedModelConfigSchema.parse({
        id: "scripted-items",
        provider: "scripted",
        model: "scripted",
        pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 },
        script: [
          {
            calls: [
              { name: "request_items", arguments: { items: [{ item: "oak_planks", count: 5 }], reason: "a test" } },
            ],
          },
          { text: "Request handled." },
        ],
      });
      const config = LabConfigSchema.parse({
        checkpoints: { enabled: false },
        server: { port: PORT, directory },
        owners: ["Approver"],
        runsDir: mkdtempSync(join(tmpdir(), "mclab-approval-runs-")),
        dashboard: { enabled: false },
        agents: [
          { name: "Asker", model: "scripted-items", harness: "skills-approval", privileges: { gameMode: "survival" } },
        ],
      });
      lab = await Lab.open(config, { models: new Map([["scripted-items", model]]) });
      lab.bus.subscribe((event) => events.push(event));
      await lab.start();
      await sleep(1_500);
    }, 90_000);

    afterAll(async () => {
      await lab?.shutdown();
      approver?.quit();
    });

    /** Sends a task, answers the bot's question with `answer`, and returns the request_items result. */
    async function requestAndAnswer(answer: string): Promise<{ ok: boolean; output: string }> {
      const owner = required(approver, "approver bot");
      const asked = questions.length;
      const start = events.length;
      owner.chat("get some planks");
      const deadline = Date.now() + 30_000;
      while (questions.length === asked && Date.now() < deadline) {
        await sleep(200);
      }
      expect(questions.at(-1)).toContain("Asker asks for 5 oak_planks (a test)");
      owner.chat(answer);
      const finished = (): LabEvent | undefined =>
        events.slice(start).find((event) => event.type === "tool.finished" && event.data.name === "request_items");
      while (finished() === undefined && Date.now() < deadline) {
        await sleep(200);
      }
      const event = finished();
      return event?.type === "tool.finished"
        ? { ok: event.data.ok, output: event.data.output }
        : { ok: false, output: "" };
    }

    it("puts approved items in the bot's inventory", async () => {
      const result = await requestAndAnswer("!approve");
      expect(result).toEqual({ ok: true, output: "Approver approved. Received 5 oak_planks." });
    }, 60_000);

    it("gives nothing when the owner denies", async () => {
      await sleep(2_000);
      const result = await requestAndAnswer("!deny not now");
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/^Approver denied the request: not now\./);
    }, 60_000);
  });
});
