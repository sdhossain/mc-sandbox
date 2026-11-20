import { join } from "node:path";

import { evaluateCase, summariseResult, type CaseResult, type CaseWorld } from "../cases/case-checks.ts";
import type { CaseLibrary } from "../cases/case-library.ts";
import { CaseStage, type PreparedCase } from "../cases/case-stage.ts";
import type { TrialStates } from "../cases/trial-states.ts";
import type { Harness, HarnessConfig } from "../harness/harness.ts";
import type { CheckpointInfo } from "../mcserver/world-checkpointer.ts";
import { HARNESS_REGISTRY } from "../harness/registry.ts";
import type { LanguageModel } from "../llm/language-model.ts";
import { BotConnection, type LifecycleKind } from "../minecraft/bot-connection.ts";
import type { ChatMessage, GameServices } from "../minecraft/game-services.ts";
import type { ServerControl } from "../minecraft/server-control/server-control.ts";
import { isOccludingBlock } from "../minecraft/names.ts";
import { formatPosition, type BlockChange } from "../minecraft/types.ts";
import { BuildSnapshotter } from "../observability/build-snapshotter.ts";
import { EventPublisher, type EventBus } from "../observability/event-bus.ts";
import { makeRunId, RunFiles, RunRecorder } from "../observability/run-recorder.ts";
import { InGameNarrator } from "../observability/sinks/in-game-narrator.ts";
import { errorMessage } from "../utils/errors.ts";
import { MessageSource, RunStatus } from "../utils/names.ts";
import { formatBytes, truncateEnd } from "../utils/text.ts";
import type { AgentConfig } from "./agent-config.ts";
import { AgentSession, type TurnOutcome } from "./agent-session.ts";
import { ApprovalDesk } from "./approval-desk.ts";
import { ChatAddressing, ControlCommand } from "./chat-addressing.ts";
import type { OwnerMessage } from "./inbox.ts";

/** What every agent shares with the rest of the lab. */
export interface LabContext {
  readonly bus: EventBus;
  readonly server: ServerControl;
  readonly owners: readonly string[];
  readonly serverAddress: { readonly host: string; readonly port: number; readonly version: string };
  readonly runsDir: string;
  /** The failure cases `!case` can run. */
  readonly cases: CaseLibrary;
  /** The server's world folder, for cases that reset an area. */
  readonly worldDir: string;
  /** The trials' saved end states, which `!load` puts back into the world. */
  readonly states: TrialStates;
  /** Saves a copy of the whole world now. Rejects when checkpoints are off or RCON is missing. */
  saveCheckpoint(label: string): Promise<CheckpointInfo>;
  /** Names of all agents in the lab, for chat addressing. */
  roster(): readonly string[];
}

/** A failure case in progress: its scene is built, and its checks run after every turn. */
interface ActiveCase {
  readonly prepared: PreparedCase;
  /** The owner who started it, who gets the results. */
  readonly owner: string;
}

const STATUS_INTERVAL_MS = 3_000;
const CHANGE_FLUSH_INTERVAL_MS = 1_000;
const MAX_REPLY_CHARS = 600;
const HELP_TEXT =
  "Talk to me in chat to give a task. Commands: !stop (stop now), !reset (forget everything, new run), !status, !case <id> (run a failure case; !case alone lists them), !check (re-run the case's checks), !approve or !deny <reason> (answer an item request), !save [label] (save a copy of the world), !load <id> (put a trial's saved end state into the world; !load alone lists them), !help. With several bots, start with a name: Sol, build a wall.";

/**
 * One bot in the world, driven by one model through one harness.
 *
 * The agent owns the bot's connection, the run directory, and the {@link AgentSession} that runs the
 * model loop. It routes chat to the session, handles control commands, records block changes and
 * snapshots, and starts a new run on `!reset`.
 */
export class Agent {
  readonly config: AgentConfig;
  readonly #lab: LabContext;
  readonly #model: LanguageModel;
  readonly #harness: Harness;
  readonly #connection: BotConnection;
  readonly #events: EventPublisher;
  readonly #session: AgentSession;
  readonly #addressing: ChatAddressing;
  readonly #approvals: ApprovalDesk;
  readonly #lifetime = new AbortController();
  #recorder: RunRecorder | null = null;
  #narrator: InGameNarrator | null = null;
  #pendingChanges: BlockChange[] = [];
  #turnStartSeq = 0;
  #activeCase: ActiveCase | null = null;
  #lastReply = "";
  #timers: ReturnType<typeof setInterval>[] = [];
  #loop: Promise<void> | null = null;

  /**
   * @param config - The agent's entry in the lab config.
   * @param harnessConfig - The validated harness preset it uses.
   * @param model - The model that drives it.
   * @param lab - What it shares with the rest of the lab.
   */
  constructor(config: AgentConfig, harnessConfig: HarnessConfig, model: LanguageModel, lab: LabContext) {
    this.config = config;
    this.#lab = lab;
    this.#model = model;
    this.#events = new EventPublisher(lab.bus, { agent: config.name, runId: "" });
    this.#connection = new BotConnection(
      { ...lab.serverAddress, username: config.name, movement: { ...config.movement, allowParkour: true } },
      (kind, detail) => {
        this.#onLifecycle(kind, detail);
      },
    );
    this.#harness = HARNESS_REGISTRY.get(harnessConfig.harness).create(harnessConfig, {
      agentName: config.name,
      owners: lab.owners,
      privileges: config.privileges,
      server: lab.server,
      game: () => this.#connection.services,
    });
    this.#addressing = new ChatAddressing(config.name, lab.owners, () => lab.roster());
    this.#approvals = new ApprovalDesk((question) => this.#announce(question));
    this.#session = new AgentSession({
      name: config.name,
      owners: lab.owners,
      model,
      harness: this.#harness,
      budget: config.budget,
      privileges: config.privileges,
      server: lab.server,
      events: this.#events,
      approvals: this.#approvals,
      game: () => this.#connection.services,
      runDir: () => this.#recorder?.runDir ?? lab.runsDir,
      reply: (text, to) => this.#reply(text, to),
      onTurnStart: () => {
        this.#turnStartSeq = this.#safeServices()?.changes.lastSeq() ?? 0;
      },
      onTurnEnd: (turn, outcome) => {
        this.#afterTurn(turn, outcome);
      },
    });
    this.#connection.onReady((services) => {
      this.#wireGame(services);
    });
  }

  /** The agent's name. */
  get name(): string {
    return this.config.name;
  }

  /** The current run id. */
  get runId(): string {
    return this.#events.origin.runId;
  }

  /** The current run directory, or null before the first run starts. */
  get runDir(): string | null {
    return this.#recorder?.runDir ?? null;
  }

  /** One line describing what the agent is doing. */
  describeStatus(): string {
    return this.#session.describeStatus();
  }

  /** Connects the bot, prepares it, starts a run and begins listening for tasks. */
  async start(): Promise<void> {
    await this.#connection.connect();
    await this.#prepareBot();
    this.#startRun();
    this.#timers.push(
      setInterval(() => {
        this.#emitStatus();
      }, STATUS_INTERVAL_MS),
      setInterval(() => {
        this.#flushChanges();
      }, CHANGE_FLUSH_INTERVAL_MS),
    );
    this.#loop = this.#session.run(this.#lifetime.signal);
  }

  /** Gives the agent a task or steering message from outside the game (dashboard, CLI). */
  submit(message: OwnerMessage): void {
    this.#session.deliver(message);
  }

  /**
   * Handles a control command from any source.
   *
   * @param argument - Text after the command, for example the case id in `!case <id>`.
   */
  async control(command: ControlCommand, from: string, source: MessageSource, argument = ""): Promise<string> {
    this.#events.emit("control.command", { source, from, command });
    switch (command) {
      case ControlCommand.STOP:
        this.#session.stopTurn(`stopped by ${from}`);
        return "Stopping.";
      case ControlCommand.RESET:
        await this.#resetRun(from);
        return "Reset: new run, empty memory.";
      case ControlCommand.STATUS:
        return this.describeStatus();
      case ControlCommand.HELP:
        return HELP_TEXT;
      case ControlCommand.CASE:
        return this.#startCase(argument, from);
      case ControlCommand.CHECK:
        return this.#checkCaseNow();
      case ControlCommand.APPROVE:
        return this.#approvals.answer({ approved: true, by: from, note: argument })
          ? "Approved."
          : "Nothing is waiting for approval.";
      case ControlCommand.DENY:
        return this.#approvals.answer({ approved: false, by: from, note: argument })
          ? "Denied."
          : "Nothing is waiting for approval.";
      case ControlCommand.SAVE:
        return this.#saveCheckpoint(argument, from);
      case ControlCommand.LOAD:
        return this.#loadState(argument);
    }
  }

  /** Records in the current run that the lab saved a world checkpoint. */
  noteCheckpoint(info: CheckpointInfo): void {
    if (this.runId === "") {
      return;
    }
    const { id, label, worldPath, gameTime, copiedBytes, linkedBytes, durationMs } = info;
    this.#events.emit("checkpoint.saved", { id, label, worldPath, gameTime, copiedBytes, linkedBytes, durationMs });
  }

  /** Ends the run and disconnects. */
  async shutdown(): Promise<void> {
    this.#session.stopTurn("lab shutting down");
    this.#lifetime.abort();
    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    await this.#loop?.catch(() => undefined);
    await this.#endRun(RunStatus.ENDED);
    this.#narrator?.close();
    this.#harness.dispose();
    await this.#connection.close();
    await this.#model.close();
  }

  #startRun(): void {
    const runId = makeRunId(new Date(), this.config.name, this.config.harness, this.#model.id);
    this.#events.setOrigin({ runId, turn: undefined, step: undefined });
    this.#recorder = new RunRecorder(this.#lab.bus, join(this.#lab.runsDir, runId), {
      runId,
      agent: this.config.name,
      harness: this.config.harness,
      model: this.#model.id,
      provider: this.#model.config.provider,
      privileges: this.config.privileges,
      minecraftVersion: this.#lab.serverAddress.version,
      owners: this.#lab.owners,
      startedAt: new Date().toISOString(),
    });
    const { pricing: _pricing, ...modelConfig } = this.#model.config;
    this.#events.emit("run.started", {
      harness: this.config.harness,
      harnessConfig: this.#harness.config,
      model: this.#model.id,
      modelConfig,
      privileges: this.config.privileges,
      instructions: this.#harness.instructions(),
      tools: this.#session.toolSpecs,
    });
    if (this.config.narration === "actionbar" && this.#lab.server.available && this.#narrator === null) {
      this.#narrator = new InGameNarrator(this.#lab.bus, this.#lab.server, this.config.name, () =>
        this.#onlineOwners(),
      );
    }
  }

  async #endRun(status: RunStatus): Promise<void> {
    this.#flushChanges();
    const recorder = this.#recorder;
    if (recorder === null) {
      return;
    }
    this.#events.emit("run.ended", { status, totals: this.#session.totals });
    this.#recorder = null;
    await recorder.finish(status, this.#session.totals);
  }

  async #resetRun(from: string): Promise<void> {
    this.#session.stopTurn(`reset by ${from}`);
    while (this.#session.busy) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.#endRun(RunStatus.RESET);
    this.#activeCase = null;
    this.#lastReply = "";
    this.#session.resetConversation();
    this.#harness.reset();
    this.#startRun();
  }

  async #prepareBot(): Promise<void> {
    const { server } = this.#lab;
    if (!server.available) {
      this.#log("warn", "No RCON connection: game mode, teleport and the action-bar status line are unavailable.");
      return;
    }
    try {
      await server.setGameMode(this.config.name, this.config.privileges.gameMode);
      const owner = this.#onlineOwners()[0];
      if (this.config.joinOwner && owner !== undefined) {
        await server.teleportToPlayer(this.config.name, owner);
      }
    } catch (error) {
      this.#log("warn", `Could not prepare the bot over RCON: ${errorMessage(error)}`);
    }
  }

  #wireGame(services: GameServices): void {
    services.chat.onMessage((message) => {
      this.#onChat(message);
    });
    services.changes.onChange((change) => {
      this.#pendingChanges.push(change);
    });
  }

  #onChat(message: ChatMessage): void {
    const line = this.#addressing.interpret(message.username, message.text, message.whisper);
    this.#events.emit("chat.received", {
      from: message.username,
      text: message.text,
      whisper: message.whisper,
      addressedToMe: line.kind !== "ignored",
    });
    const source = message.whisper ? MessageSource.WHISPER : MessageSource.CHAT;
    if (line.kind === "task") {
      this.#session.deliver({ source, from: message.username, text: line.text, receivedAtMs: message.receivedAtMs });
    } else if (line.kind === "control") {
      void this.control(line.command, message.username, source, line.argument).then((answer) =>
        this.#reply(answer, { source, from: message.username, text: "", receivedAtMs: message.receivedAtMs }),
      );
    }
  }

  async #reply(text: string, to: OwnerMessage): Promise<void> {
    const services = this.#safeServices();
    if (services === null) {
      return;
    }
    const message = truncateEnd(text, MAX_REPLY_CHARS);
    if (to.source === MessageSource.WHISPER) {
      await services.chat.whisper(to.from, message);
      this.#events.emit("chat.sent", { text: message, to: to.from });
    } else {
      await services.chat.say(message);
      this.#events.emit("chat.sent", { text: message });
    }
  }

  #afterTurn(turn: number, outcome: TurnOutcome): void {
    this.#flushChanges();
    this.#lastReply = outcome.finalText;
    const services = this.#safeServices();
    const recorder = this.#recorder;
    if (services === null || recorder === null) {
      return;
    }
    this.#saveSnapshots(turn, services, recorder);
    if (this.#activeCase !== null) {
      this.#reportCase(this.#activeCase, turn, services, recorder);
    }
  }

  #saveSnapshots(turn: number, services: GameServices, recorder: RunRecorder): void {
    try {
      const snapshots = new BuildSnapshotter(services.scanner, services.changes).capture(this.#turnStartSeq);
      if (snapshots === null) {
        return;
      }
      const prefix = `${RunFiles.SNAPSHOT_DIR}/turn-${String(turn).padStart(3, "0")}`;
      const beforeFile = recorder.writeJson(`${prefix}.before.json`, snapshots.before);
      const afterFile = recorder.writeJson(`${prefix}.after.json`, snapshots.after);
      this.#events.emit("snapshot.saved", {
        file: beforeFile,
        phase: "before",
        blocks: snapshots.before.blocks.length,
      });
      this.#events.emit("snapshot.saved", { file: afterFile, phase: "after", blocks: snapshots.after.blocks.length });
    } catch (error) {
      this.#log("warn", `Could not save the turn's snapshots: ${errorMessage(error)}`);
    }
  }

  /** `!case <id> [force]`: builds the case's scene around the owner in a fresh run and sends its task. */
  async #startCase(argument: string, from: string): Promise<string> {
    const [id = "", option = ""] = argument.trim().split(/\s+/);
    if (id === "") {
      const ids = this.#lab.cases.list().map((definition) => definition.id);
      return ids.length === 0
        ? "There are no cases in configs/cases."
        : `Cases: ${ids.join(", ")}. Run one: !case <id>`;
    }
    try {
      const definition = this.#lab.cases.get(id);
      const mode = this.config.privileges.gameMode;
      if (definition.gameMode !== "any" && definition.gameMode !== mode) {
        return `Case ${id} needs a ${definition.gameMode}-mode agent and I am in ${mode} mode. Restart with: npm start -- --game-mode ${definition.gameMode}`;
      }
      const services = this.#safeServices();
      if (services === null) {
        return "I am not connected.";
      }
      // Cases with a fixed anchor are set in one place; the others are built around the owner.
      const ownerPosition = services.scanner.player(from)?.position ?? null;
      if (definition.anchor === undefined && ownerPosition === null) {
        return `I need to see you to build the scene around you. Come closer and try again.`;
      }
      await this.#resetRun(from);
      const stage = new CaseStage(
        this.#lab.server,
        services,
        { owner: from, bot: this.config.name },
        { worldDir: this.#lab.worldDir, baselinePath: this.#lab.cases.baselinePath(id) },
      );
      const prepared = await stage.prepare(definition, ownerPosition, option === "force");
      this.#activeCase = { prepared, owner: from };
      const { anchor } = prepared.scene;
      this.#recorder?.writeJson(RunFiles.CASE, {
        definition,
        anchor,
        prompt: prepared.prompt,
        commands: prepared.commands,
      });
      this.#events.emit("case.started", {
        id,
        title: definition.title,
        category: definition.category,
        anchor,
        prompt: prepared.prompt,
      });
      this.#session.deliver({ source: MessageSource.CASE, from, text: prepared.prompt, receivedAtMs: Date.now() });
      return `Case ${id} (${definition.title}): scene built around ${formatPosition(anchor)}. Task: ${prepared.prompt}`;
    } catch (error) {
      return `Could not start case ${id}: ${errorMessage(error)}`;
    }
  }

  /** `!save [label]`: saves a copy of the whole world now. */
  async #saveCheckpoint(label: string, from: string): Promise<string> {
    try {
      const info = await this.#lab.saveCheckpoint(label.trim() === "" ? `saved by ${from}` : label.trim());
      return `Saved checkpoint ${info.id} (${formatBytes(info.copiedBytes)} new).`;
    } catch (error) {
      return `Could not save a checkpoint: ${errorMessage(error)}`;
    }
  }

  /** `!load <id>`: puts a trial's saved end state, or a case's start state, into the world; `!load` lists them. */
  async #loadState(argument: string): Promise<string> {
    const id = argument.trim();
    try {
      if (id === "") {
        return this.#lab.states.describeRecent();
      }
      if (this.#session.busy) {
        return "I am in the middle of a task, and loading would change the area under me. Send !stop first.";
      }
      return await this.#lab.states.load(id);
    } catch (error) {
      return `Could not load ${id === "" ? "the saved states" : id}: ${errorMessage(error)}`;
    }
  }

  /** `!check`: evaluates the running case's checks again now, for example after a follow-up message. */
  #checkCaseNow(): string {
    const services = this.#safeServices();
    const recorder = this.#recorder;
    if (this.#activeCase === null) {
      return "No case is running. Start one with !case <id>.";
    }
    if (services === null || recorder === null) {
      return "I am not connected.";
    }
    return summariseResult(this.#reportCase(this.#activeCase, this.#session.totals.turns, services, recorder));
  }

  /** Evaluates the case, records the result, and tells the owner privately. */
  #reportCase(active: ActiveCase, turn: number, services: GameServices, recorder: RunRecorder): CaseResult {
    const world: CaseWorld = {
      blockAt: (position) => services.scanner.blockAt(position),
      inventoryCount: (item) => services.inventory.count(item),
      isOccluder: (name) => isOccludingBlock(services.mcData, name),
    };
    const { definition, scene } = active.prepared;
    const result = evaluateCase(definition, scene, world, this.#lastReply, turn);
    recorder.writeJson(`case-result-turn-${String(turn).padStart(3, "0")}.json`, result);
    this.#events.emit("case.result", result);
    this.#lab.server.tell(active.owner, summariseResult(result)).catch((error: unknown) => {
      this.#log("warn", `Could not send the case result: ${errorMessage(error)}`);
    });
    return result;
  }

  #onLifecycle(kind: LifecycleKind, detail: string): void {
    if (this.runId !== "") {
      this.#events.emit("bot.lifecycle", { kind, detail });
    } else {
      console.log(`[${this.config.name}] ${kind}: ${detail}`);
    }
    if (kind === "disconnected" || kind === "kicked") {
      this.#session.stopTurn(`bot ${kind}`);
    }
  }

  #emitStatus(): void {
    const services = this.#safeServices();
    if (services !== null && this.runId !== "") {
      this.#events.emit("bot.status", services.scanner.status());
    }
  }

  #flushChanges(): void {
    if (this.#pendingChanges.length === 0 || this.runId === "") {
      return;
    }
    const changes = this.#pendingChanges;
    this.#pendingChanges = [];
    this.#events.emit("world.changes", { changes });
  }

  #onlineOwners(): string[] {
    const services = this.#safeServices();
    if (services === null) {
      return [];
    }
    const online = new Set(services.scanner.players().map((player) => player.username.toLowerCase()));
    return this.#lab.owners.filter((owner) => online.has(owner.toLowerCase()));
  }

  /** Says a question for the owner in chat, where they answer with `!approve` or `!deny`. */
  async #announce(question: string): Promise<void> {
    const services = this.#safeServices();
    if (services === null) {
      throw new Error("The bot is not connected, so it cannot ask the owner.");
    }
    await services.chat.say(question);
    this.#events.emit("chat.sent", { text: question });
  }

  #safeServices(): GameServices | null {
    return this.#connection.isConnected ? this.#connection.services : null;
  }

  #log(level: "info" | "warn" | "error", message: string): void {
    if (this.runId !== "") {
      this.#events.emit("log", { level, message });
    } else {
      console.log(`[${this.config.name}] ${level}: ${message}`);
    }
  }
}
