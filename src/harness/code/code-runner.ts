import { createRequire } from "node:module";
import { createContext, Script } from "node:vm";

import minecraftData from "minecraft-data";
import pathfinderPackage from "mineflayer-pathfinder";
import type { Item as ItemClass } from "prismarine-item";
import { Vec3 } from "vec3";

import type { GameServices } from "../../minecraft/game-services.ts";
import type { ServerControl } from "../../minecraft/server-control/server-control.ts";
import { sleep } from "../../utils/abort.ts";
import { errorMessage } from "../../utils/errors.ts";
import { createCodeSkills } from "./code-skills.ts";
import { CodeSyntaxError, GUARD_NAME, prepareCode } from "./loop-guard.ts";

const { goals, Movements } = pathfinderPackage;
/** prismarine-item's loader (a CommonJS function, whatever its type declarations say). */
const loadItemClass = createRequire(import.meta.url)("prismarine-item") as (version: string) => typeof ItemClass;

/** Event-emitter methods whose listeners are removed when a call ends. */
const LISTENER_METHODS = new Set<PropertyKey>(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
/** Synchronous code may hold the event loop this long before it is stopped; longer freezes the bot. */
const MAX_BLOCKING_MS = 2_000;
const MAX_LOG_CHARS = 40_000;

/** What one execution produced. */
export interface CodeResult {
  readonly ok: boolean;
  readonly logs: readonly string[];
  /** The returned value as JSON (or text), null when nothing was returned. */
  readonly returned: string | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

/** Everything a run needs besides the code. */
export interface CodeRunOptions {
  readonly game: GameServices;
  readonly server: ServerControl;
  readonly agentName: string;
  readonly commands: boolean;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly progress: (message: string) => void;
}

/** Thrown inside model code once its call is over. */
class CancelledError extends Error {
  constructor(reason: string) {
    super(`Cancelled: ${reason}`);
    this.name = "CancelledError";
  }
}

/**
 * Runs model-written JavaScript against the live bot.
 *
 * The code is the body of an async function. It sees `bot` (the Mineflayer bot), `Vec3`, `mcData`,
 * `Item`, `goals`, `Movements`, `skills` (when helpers are on), `state` (an object kept between calls
 * of the same run), `log`/`console`, `sleep`, `isCancelled` and `signal`.
 *
 * Each call gets a deadline. When the deadline passes or the owner stops the agent, the call is
 * cancelled: every later access to `bot` or `skills` throws, loop guards throw, pathfinding stops,
 * and the timers and bot listeners the call created are removed, so leftover code cannot interfere
 * with the next call.
 *
 * This is not a security sandbox: the code runs in the lab's process with full access to the bot.
 * It is meant for models you are willing to give a Mineflayer bot to, on your own local server.
 */
export class CodeRunner {
  readonly #helpers: boolean;
  #state: Record<string, unknown> = {};

  /** @param helpers - Expose the `skills` library to the code (false gives the raw Mineflayer API only). */
  constructor(helpers: boolean) {
    this.#helpers = helpers;
  }

  /** Forgets everything stored in `state`. */
  reset(): void {
    this.#state = {};
  }

  /** Checks, instruments and runs `code`. Never throws; failures are in the result. */
  async run(code: string, options: CodeRunOptions): Promise<CodeResult> {
    const started = performance.now();
    const logs: string[] = [];
    let logChars = 0;
    const log = (level: string, values: unknown[]): void => {
      const line = (level === "log" ? "" : `[${level}] `) + values.map(formatValue).join(" ");
      logChars += line.length;
      if (logChars <= MAX_LOG_CHARS) {
        logs.push(line);
      }
    };
    const result = (fields: Partial<CodeResult>): CodeResult => ({
      ok: false,
      logs,
      returned: null,
      error: null,
      timedOut: false,
      cancelled: false,
      durationMs: Math.round(performance.now() - started),
      ...fields,
    });

    let prepared;
    try {
      prepared = prepareCode(code);
    } catch (error) {
      return result({
        error: error instanceof CodeSyntaxError ? `SyntaxError: ${error.message}` : errorMessage(error),
      });
    }

    const cancellation = new AbortController();
    // Held in an object because closures assign it; TypeScript does not track closure assignments to a `let`.
    const status: { reason: string | null } = { reason: null };
    const cancel = (reason: string): void => {
      if (status.reason === null) {
        status.reason = reason;
        cancellation.abort(new CancelledError(reason));
      }
    };
    const onOuterAbort = (): void => {
      cancel("stopped by the owner");
    };
    options.signal.addEventListener("abort", onOuterAbort, { once: true });
    const deadline = Date.now() + options.timeoutMs;
    let lastTurn = Date.now();
    const heartbeat = setInterval(() => {
      lastTurn = Date.now();
      if (Date.now() > deadline) {
        cancel(`time limit of ${options.timeoutMs / 1000} s reached`);
      }
    }, 100);

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const listeners: [PropertyKey, string | symbol, (...args: unknown[]) => void][] = [];
    const bot = options.game.bot;
    const botProxy = new Proxy(bot, {
      get: (target, property) => {
        if (status.reason !== null) {
          throw new CancelledError(status.reason);
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        const method = value as (...args: unknown[]) => unknown;
        if (LISTENER_METHODS.has(property)) {
          return (event: string | symbol, listener: (...args: unknown[]) => void) => {
            listeners.push([property, event, listener]);
            return method.call(target, event, listener);
          };
        }
        return method.bind(target);
      },
    });
    const skills = this.#helpers
      ? guardObject(createCodeSkills(options.game, cancellation.signal, options.progress), () => status.reason)
      : undefined;
    const guard = (): void => {
      if (status.reason !== null) {
        throw new CancelledError(status.reason);
      }
      if (Date.now() - lastTurn > MAX_BLOCKING_MS) {
        const reason = `the code ran ${MAX_BLOCKING_MS / 1000} s without awaiting, which freezes the bot; await inside long loops (for example await sleep(0))`;
        cancel(reason);
        throw new CancelledError(reason);
      }
    };

    const sandbox: Record<string, unknown> = {
      bot: botProxy,
      Vec3,
      mcData: minecraftData(bot.version),
      Item: loadItemClass(bot.version),
      goals,
      Movements,
      state: this.#state,
      signal: cancellation.signal,
      isCancelled: () => status.reason !== null,
      sleep: (ms: number) => sleep(ms, cancellation.signal),
      log: (...values: unknown[]) => {
        log("log", values);
      },
      console: {
        log: (...values: unknown[]) => {
          log("log", values);
        },
        info: (...values: unknown[]) => {
          log("log", values);
        },
        warn: (...values: unknown[]) => {
          log("warn", values);
        },
        error: (...values: unknown[]) => {
          log("error", values);
        },
      },
      setTimeout: (callback: () => void, ms?: number) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (status.reason === null) {
            callback();
          }
        }, ms);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
        timers.delete(timer);
      },
      [GUARD_NAME]: guard,
      ...(skills === undefined ? {} : { skills }),
      ...(options.commands
        ? { commands: { run: (command: string) => options.server.runAs(options.agentName, command) } }
        : {}),
    };

    try {
      const context = createContext(sandbox, { name: "agent-code", codeGeneration: { strings: false, wasm: false } });
      const fn = new Script(prepared.source, { filename: "agent-code.js" }).runInContext(
        context,
      ) as () => Promise<unknown>;
      const cancelled = new Promise<never>((_, reject) => {
        cancellation.signal.addEventListener("abort", () => {
          reject(cancellation.signal.reason as Error);
        });
      });
      const value = await Promise.race([fn(), cancelled]);
      return result({ ok: true, returned: value === undefined ? null : formatValue(value) });
    } catch (error) {
      const message = describeError(error, prepared.lineOffset);
      const timedOut = status.reason?.startsWith("time limit") ?? false;
      return result({ error: message, timedOut, cancelled: status.reason !== null });
    } finally {
      cancel("the call ended");
      clearInterval(heartbeat);
      options.signal.removeEventListener("abort", onOuterAbort);
      for (const timer of timers) {
        clearTimeout(timer);
      }
      const emitter = bot as unknown as NodeJS.EventEmitter;
      for (const [, event, listener] of listeners) {
        emitter.removeListener(event, listener);
      }
      options.game.navigator.stop();
      bot.stopDigging();
    }
  }
}

/** Wraps every function of `target` so it throws once the call is cancelled. */
function guardObject(target: Record<string, unknown>, reason: () => string | null): Record<string, unknown> {
  const guarded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    guarded[name] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            const why = reason();
            if (why !== null) {
              throw new CancelledError(why);
            }
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return guarded;
}

/** An error from any realm: errors thrown inside the code's context are not `instanceof Error` here. */
function asErrorLike(value: unknown): { name: string; message: string; stack: string } | null {
  if (typeof value !== "object" || value === null || !("message" in value)) {
    return null;
  }
  const { name, message, stack } = value as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof name === "string" ? name : "Error",
    message: String(message),
    stack: typeof stack === "string" ? stack : "",
  };
}

/** The error message, with the line number in the model's code when the stack has one. */
function describeError(error: unknown, lineOffset: number): string {
  const errorLike = asErrorLike(error);
  const message = errorLike === null ? String(error) : `${errorLike.name}: ${errorLike.message}`;
  const stack = errorLike?.stack ?? "";
  const location = /agent-code\.js:(\d+):(\d+)/.exec(stack);
  if (location === null) {
    return message;
  }
  return `${message} (line ${Number(location[1]) - lineOffset})`;
}

/** Formats a logged or returned value: strings as-is, everything else as compact JSON. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const errorLike = asErrorLike(value);
  if (errorLike !== null && errorLike.stack !== "") {
    return `${errorLike.name}: ${errorLike.message}`;
  }
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") {
        return item.toString();
      }
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) {
          return "[circular]";
        }
        seen.add(item);
      }
      return item;
    });
    // JSON.stringify returns undefined for functions and undefined, whatever its type says.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
