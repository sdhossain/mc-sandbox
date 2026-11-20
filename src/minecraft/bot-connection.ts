import minecraftData from "minecraft-data";
import { createBot, type Bot } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";

import { sleep } from "../utils/abort.ts";
import { ActionError, errorMessage, LabError } from "../utils/errors.ts";
import type { GameServices } from "./game-services.ts";
import { MineflayerGameServices } from "./mineflayer-game-services.ts";
import { DEFAULT_MOVEMENT_SETTINGS, type MovementSettings } from "./pathfinder-navigator.ts";

const { pathfinder } = pathfinderPackage;

/** Where and as whom to connect. */
export interface BotConnectionOptions {
  readonly host: string;
  readonly port: number;
  /** The bot's player name, 3 to 16 letters, digits or underscores. */
  readonly username: string;
  /** Minecraft version, for example `1.21.11`. */
  readonly version: string;
  readonly movement?: MovementSettings;
  /** Reconnect after an unexpected disconnect. Default true. */
  readonly reconnect?: boolean;
}

/** Connection and life events, reported to the agent. */
export type LifecycleKind =
  "connecting" | "spawned" | "died" | "respawned" | "kicked" | "disconnected" | "reconnecting";

/** Receives connection and life events. */
export type LifecycleListener = (kind: LifecycleKind, detail: string) => void;

const SPAWN_TIMEOUT_MS = 60_000;
/** Waits before each reconnect attempt; the last one repeats until the server is back or the lab closes. */
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

/**
 * Owns one bot's connection to the server: connects, waits for spawn, builds the game layer, reports
 * deaths and kicks, and reconnects after an unexpected disconnect.
 *
 * The game layer is rebuilt on every connect, so holders must read {@link services} when they need it
 * rather than keep a reference, and re-register listeners in {@link onReady}.
 */
export class BotConnection {
  readonly #options: BotConnectionOptions;
  readonly #onLifecycle: LifecycleListener;
  readonly #readyListeners = new Set<(services: GameServices) => void>();
  #bot: Bot | null = null;
  #services: MineflayerGameServices | null = null;
  #closing = false;
  #reconnectAttempts = 0;

  /**
   * @param options - Server address, bot name and version.
   * @param onLifecycle - Receives connection and life events.
   */
  constructor(options: BotConnectionOptions, onLifecycle: LifecycleListener) {
    this.#options = options;
    this.#onLifecycle = onLifecycle;
  }

  /** The current game layer. Throws `ActionError` while the bot is not connected. */
  get services(): GameServices {
    if (this.#services === null) {
      throw new ActionError("The bot is not connected to the server right now.");
    }
    return this.#services;
  }

  /** True while the bot is spawned in the world. */
  get isConnected(): boolean {
    return this.#services !== null;
  }

  /** Registers a listener called with the fresh game layer after every (re)spawn. Returns a remover. */
  onReady(listener: (services: GameServices) => void): () => void {
    this.#readyListeners.add(listener);
    return () => {
      this.#readyListeners.delete(listener);
    };
  }

  /**
   * Connects and waits until the bot has spawned.
   *
   * @throws LabError when the server refuses the connection or the bot does not spawn within 60 s.
   */
  async connect(): Promise<GameServices> {
    this.#closing = false;
    const { host, port, username, version } = this.#options;
    this.#onLifecycle("connecting", `${username} connecting to ${host}:${port} (Minecraft ${version})`);
    // hideErrors: connection errors are reported through the lifecycle listener instead of dumped to stderr.
    const bot = createBot({
      host,
      port,
      username,
      version,
      auth: "offline",
      checkTimeoutInterval: 60_000,
      hideErrors: true,
    });
    bot.loadPlugin(pathfinder);
    this.#bot = bot;
    await this.#waitForSpawn(bot);
    this.#attachLifecycle(bot);
    const services = new MineflayerGameServices(
      bot,
      minecraftData(version),
      this.#options.movement ?? DEFAULT_MOVEMENT_SETTINGS,
    );
    this.#services = services;
    this.#reconnectAttempts = 0;
    this.#onLifecycle("spawned", `${username} spawned at ${bot.entity.position.floored().toString()}`);
    for (const listener of this.#readyListeners) {
      listener(services);
    }
    return services;
  }

  /** Disconnects for good; no reconnect follows. */
  async close(): Promise<void> {
    this.#closing = true;
    const bot = this.#bot;
    this.#teardown();
    if (bot !== null) {
      const ended = new Promise<void>((resolve) =>
        bot.once("end", () => {
          resolve();
        }),
      );
      bot.quit("Lab shutting down");
      await Promise.race([ended, sleep(3_000)]);
    }
  }

  #waitForSpawn(bot: Bot): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        bot.end("spawn timeout");
        reject(
          new LabError(
            `The bot did not spawn within ${SPAWN_TIMEOUT_MS / 1000} s. Is the server running and in offline mode?`,
          ),
        );
      }, SPAWN_TIMEOUT_MS);
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onFailure = (reason: unknown): void => {
        cleanup();
        reject(new LabError(`Could not join ${this.#options.host}:${this.#options.port}: ${describeReason(reason)}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        bot.removeListener("spawn", onSpawn);
        bot.removeListener("error", onFailure);
        bot.removeListener("kicked", onFailure);
        bot.removeListener("end", onFailure);
      };
      bot.once("spawn", onSpawn);
      bot.once("error", onFailure);
      bot.once("kicked", onFailure);
      bot.once("end", onFailure);
    });
  }

  #attachLifecycle(bot: Bot): void {
    bot.on("death", () => {
      this.#onLifecycle("died", `${bot.username} died at ${bot.entity.position.floored().toString()}`);
    });
    bot.on("spawn", () => {
      this.#onLifecycle("respawned", `${bot.username} respawned at ${bot.entity.position.floored().toString()}`);
    });
    bot.on("kicked", (reason) => {
      this.#onLifecycle("kicked", describeReason(reason));
    });
    bot.on("error", (error) => {
      this.#onLifecycle("disconnected", `connection error: ${errorMessage(error)}`);
    });
    bot.on("end", (reason) => {
      this.#teardown();
      if (this.#closing) {
        return;
      }
      this.#onLifecycle("disconnected", `connection ended: ${reason}`);
      if (this.#options.reconnect !== false) {
        void this.#reconnect();
      }
    });
  }

  async #reconnect(): Promise<void> {
    // No attempt limit: a server that is down for a long time costs one refused connection every 30 s.
    while (!this.#closing) {
      const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
      this.#reconnectAttempts += 1;
      this.#onLifecycle("reconnecting", `attempt ${this.#reconnectAttempts} in ${delay / 1000} s`);
      await sleep(delay);
      if (this.#isClosing()) {
        return;
      }
      try {
        await this.connect();
        return;
      } catch (error) {
        this.#onLifecycle("disconnected", errorMessage(error));
      }
    }
  }

  /** Reads the flag afresh; a plain read after an await is wrongly narrowed by the type checker. */
  #isClosing(): boolean {
    return this.#closing;
  }

  #teardown(): void {
    this.#services?.dispose();
    this.#services = null;
    this.#bot = null;
  }
}

/** Turns a kick reason (a string, a chat component or its JSON) into readable text. */
function describeReason(reason: unknown): string {
  if (typeof reason === "string") {
    try {
      return describeReason(JSON.parse(reason));
    } catch {
      return reason;
    }
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "object" && reason !== null) {
    const component = reason as { text?: unknown; translate?: unknown; extra?: unknown[]; with?: unknown[] };
    const parts = [component.text, component.translate, ...(component.with ?? []), ...(component.extra ?? [])]
      .map((part) => (typeof part === "string" ? part : part === undefined ? "" : describeReason(part)))
      .filter((part) => part.length > 0);
    return parts.join(" ") || JSON.stringify(reason);
  }
  return String(reason);
}
