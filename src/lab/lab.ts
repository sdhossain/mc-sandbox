import { join } from "node:path";

import { Agent, type LabContext } from "../agent/agent.ts";
import { CaseLibrary } from "../cases/case-library.ts";
import { TrialStates } from "../cases/trial-states.ts";
import type { LabConfig } from "../config/lab-config.ts";
import { ConfigPaths, loadHarnessPreset } from "../config/load-config.ts";
import type { ModelConfig } from "../llm/language-model.ts";
import { PROVIDER_REGISTRY } from "../llm/registry.ts";
import { LiveRegions } from "../mcserver/live-regions.ts";
import { ServerProperties } from "../mcserver/server-properties.ts";
import { WorldCheckpointer, type CheckpointInfo } from "../mcserver/world-checkpointer.ts";
import { RconServerControl } from "../minecraft/server-control/rcon-server-control.ts";
import { NullServerControl, type ServerControl } from "../minecraft/server-control/server-control.ts";
import { EventBus } from "../observability/event-bus.ts";
import { ConsoleSink } from "../observability/sinks/console-sink.ts";
import { ConfigError, errorMessage, LabError } from "../utils/errors.ts";
import { formatBytes } from "../utils/text.ts";

/** Options for {@link Lab.open}. */
export interface LabOptions {
  /** Model presets by id, from `configs/models.yaml`. */
  readonly models: ReadonlyMap<string, ModelConfig>;
  /** Directory of harness presets. */
  readonly harnessDir?: string;
  /** Directory of failure cases. */
  readonly caseDir?: string;
  /** Print model text and full tool output to the terminal. */
  readonly verbose?: boolean;
}

/** Everything {@link Lab.open} builds. */
interface LabParts {
  readonly config: LabConfig;
  readonly bus: EventBus;
  readonly server: ServerControl;
  /** Filled in after the lab exists, because each agent's context refers back to the lab. */
  readonly agents: Agent[];
  readonly console: ConsoleSink;
  readonly checkpoints: WorldCheckpointer | null;
  readonly states: TrialStates;
}

/**
 * The running lab: one event bus, one operator channel to the server, and the agents.
 *
 * {@link open} validates everything (models, harness presets, API keys) before any bot joins, so a
 * config mistake fails fast with a clear message instead of halfway through a session. While it runs,
 * it saves world checkpoints when it starts and every few minutes (see `checkpoints` in the config).
 */
export class Lab {
  readonly bus: EventBus;
  readonly config: LabConfig;
  readonly server: ServerControl;
  /** Saves copies of the world; null when checkpoints are off or there is no RCON. */
  readonly checkpoints: WorldCheckpointer | null;
  /** The trials' saved end states, which `!load` puts back into the world. */
  readonly states: TrialStates;
  readonly #agents: Agent[];
  readonly #console: ConsoleSink;
  #checkpointTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(parts: LabParts) {
    this.config = parts.config;
    this.bus = parts.bus;
    this.server = parts.server;
    this.#agents = parts.agents;
    this.#console = parts.console;
    this.checkpoints = parts.checkpoints;
    this.states = parts.states;
  }

  /**
   * Builds the lab from a validated config: connects RCON when possible, then builds every agent.
   *
   * @throws ConfigError for unknown model ids or harness presets, or a missing API key.
   */
  static async open(config: LabConfig, options: LabOptions): Promise<Lab> {
    const bus = new EventBus();
    const consoleSink = new ConsoleSink(bus, options.verbose ?? false);
    const server = await connectServerControl(config);
    const worldDir = worldDirectoryOf(config);
    const checkpoints =
      config.checkpoints.enabled && server.available
        ? new WorldCheckpointer(server, worldDir, config.checkpoints.dir)
        : null;
    const cases = CaseLibrary.load(options.caseDir ?? ConfigPaths.CASES);
    const states = new TrialStates(config.runsDir, cases, new LiveRegions(server, worldDir));
    // The lab holds this array, and the agents are added to it below.
    const agents: Agent[] = [];
    const lab = new Lab({ config, bus, server, agents, console: consoleSink, checkpoints, states });
    const context: LabContext = {
      bus,
      server,
      owners: config.owners,
      serverAddress: { host: config.server.host, port: config.server.port, version: config.server.version },
      runsDir: config.runsDir,
      cases,
      worldDir,
      states,
      roster: () => agents.map((agent) => agent.name),
      saveCheckpoint: (label) => lab.saveCheckpoint(label),
    };
    const names = new Set<string>();
    for (const agentConfig of config.agents) {
      if (names.has(agentConfig.name.toLowerCase())) {
        throw new ConfigError(`Two agents are named "${agentConfig.name}".`);
      }
      names.add(agentConfig.name.toLowerCase());
      const modelConfig = options.models.get(agentConfig.model);
      if (modelConfig === undefined) {
        throw new ConfigError(
          `Agent ${agentConfig.name}: unknown model "${agentConfig.model}". Known: ${[...options.models.keys()].join(", ")}.`,
        );
      }
      const harnessConfig = loadHarnessPreset(agentConfig.harness, options.harnessDir);
      const model = PROVIDER_REGISTRY.get(modelConfig.provider).create(modelConfig);
      agents.push(new Agent(agentConfig, harnessConfig, model, context));
    }
    return lab;
  }

  /** The agents, in config order. */
  get agents(): readonly Agent[] {
    return this.#agents;
  }

  /** The agent named `name` (any case), or undefined. */
  agent(name: string): Agent | undefined {
    return this.#agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
  }

  /** Connects every agent's bot, one after another, then starts the checkpoint timer. */
  async start(): Promise<void> {
    for (const agent of this.#agents) {
      await agent.start();
    }
    const { atStart, everyMinutes } = this.config.checkpoints;
    if (this.checkpoints === null) {
      if (this.config.checkpoints.enabled) {
        console.warn("[lab] World checkpoints are off: they need RCON.");
      }
      return;
    }
    if (atStart) {
      this.#saveInBackground("lab start");
    }
    if (everyMinutes > 0) {
      this.#checkpointTimer = setInterval(() => {
        this.#saveInBackground(`every ${everyMinutes} min`);
      }, everyMinutes * 60_000);
    }
  }

  /**
   * Saves a world checkpoint now and records it in every agent's run.
   *
   * @throws LabError when checkpoints are off or RCON is missing.
   */
  async saveCheckpoint(label: string): Promise<CheckpointInfo> {
    if (this.checkpoints === null) {
      throw new LabError('World checkpoints are off: they need RCON and "checkpoints.enabled" in configs/lab.yaml.');
    }
    const runs = this.#agents.map((agent) => ({
      agent: agent.name,
      runId: agent.runId,
      status: agent.describeStatus(),
    }));
    const info = await this.checkpoints.save(label, { runs });
    for (const agent of this.#agents) {
      agent.noteCheckpoint(info);
    }
    return info;
  }

  /** Ends every run, disconnects the bots and closes RCON. */
  async shutdown(): Promise<void> {
    if (this.#checkpointTimer !== null) {
      clearInterval(this.#checkpointTimer);
    }
    await Promise.all(this.#agents.map((agent) => agent.shutdown().catch(() => undefined)));
    await this.server.close();
    this.#console.close();
  }

  #saveInBackground(label: string): void {
    this.saveCheckpoint(label).then(
      (info) => {
        console.log(`[lab] World checkpoint ${info.id} (${formatBytes(info.copiedBytes)} new)`);
      },
      (error: unknown) => {
        console.warn(`[lab] World checkpoint failed: ${errorMessage(error)}`);
      },
    );
  }
}

/** The server's world folder: `level-name` (default `world`) inside the server directory. */
export function worldDirectoryOf(config: LabConfig): string {
  const properties = join(config.server.directory, "server.properties");
  let levelName = "world";
  try {
    levelName = ServerProperties.read(properties).get("level-name") ?? "world";
  } catch {
    // No server.properties yet: the server uses the default name.
  }
  return join(config.server.directory, levelName);
}

/** Connects RCON with settings from the lab config, falling back to the local server's server.properties. */
export async function connectServerControl(config: LabConfig): Promise<ServerControl> {
  const rcon = config.server.rcon;
  if (!rcon.enabled) {
    return new NullServerControl();
  }
  const properties = ServerProperties.read(join(config.server.directory, "server.properties"));
  const password = rcon.password ?? properties.get("rcon.password");
  const port = rcon.port ?? Number(properties.get("rcon.port") ?? 25575);
  const host = rcon.host ?? config.server.host;
  if (password === undefined || password === "") {
    console.warn(
      `[lab] No RCON password (not in configs/lab.yaml nor ${join(config.server.directory, "server.properties")}); running without RCON.`,
    );
    return new NullServerControl();
  }
  try {
    return await RconServerControl.connect(host, port, password);
  } catch (error) {
    console.warn(`[lab] RCON unavailable (${errorMessage(error)}); running without it.`);
    return new NullServerControl();
  }
}
