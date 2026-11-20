import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LabError } from "../utils/errors.ts";
import { EULA_URL } from "./server-installer.ts";
import { ServerProperties } from "./server-properties.ts";

/** How to run the server. */
export interface ServerProcessOptions {
  readonly directory: string;
  readonly javaPath: string;
  /** Maximum heap, for example `4G`. */
  readonly memory?: string;
  /** Pass the server console through to this terminal (interactive use). Otherwise output is captured. */
  readonly interactive?: boolean;
}

const DONE_PATTERN = /Done \([\d.]+s\)! For help, type "help"/;
/** Vanilla starts the RCON listener just after "Done", so readiness waits for this line too when RCON is on. */
const RCON_READY_TEXT = "RCON running on";
const STOP_TIMEOUT_MS = 30_000;
/** Console output kept in memory, for error messages. */
const MAX_OUTPUT_CHARS = 64_000;

/** Runs the vanilla server as a child process, and stops it cleanly with `stop`. */
export class ServerProcess {
  readonly #options: ServerProcessOptions;
  #child: ChildProcess | null = null;
  #output = "";

  /** @param options - The server folder, Java and memory. */
  constructor(options: ServerProcessOptions) {
    this.#options = options;
  }

  /** The most recent server console output (up to 64,000 characters). */
  get output(): string {
    return this.#output;
  }

  /**
   * Starts the server and resolves once it reports "Done" (and, with RCON enabled, once RCON is
   * listening), or rejects if it exits first.
   *
   * @throws LabError when the jar or EULA acceptance is missing.
   */
  async start(timeoutMs = 180_000): Promise<void> {
    const { directory, javaPath, memory = "4G", interactive = false } = this.#options;
    if (!existsSync(join(directory, "server.jar"))) {
      throw new LabError(`No server.jar in ${directory}. Run: npm run server:setup`);
    }
    const eula = join(directory, "eula.txt");
    if (!existsSync(eula) || !/^eula=true$/m.test(readFileSync(eula, "utf8"))) {
      throw new LabError(
        `The Minecraft EULA has not been accepted in ${eula}. Read ${EULA_URL}; if you agree, run: npm run server:setup -- --accept-eula`,
      );
    }
    const child = spawn(javaPath, [`-Xmx${memory}`, "-Xms1G", "-jar", "server.jar", "nogui"], {
      cwd: directory,
      stdio: interactive ? ["inherit", "pipe", "inherit"] : ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    const rconEnabled = ServerProperties.read(join(directory, "server.properties")).get("enable-rcon") === "true";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new LabError(`The server did not finish starting within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      let done = false;
      let rconReady = !rconEnabled;
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (interactive) {
          process.stdout.write(text);
        }
        // Test the recent output rather than the chunk, so a line split across chunks still matches.
        const recent = this.#capture(text).slice(-(text.length + 200));
        done ||= DONE_PATTERN.test(recent);
        rconReady ||= recent.includes(RCON_READY_TEXT);
        if (done && rconReady) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.#capture(chunk.toString());
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new LabError(`The server exited with code ${code} before it was ready.\n${this.#output.slice(-2_000)}`));
      });
    });
  }

  /** Appends console text to the capped in-memory copy and returns that copy. */
  #capture(text: string): string {
    this.#output = (this.#output + text).slice(-MAX_OUTPUT_CHARS);
    return this.#output;
  }

  /** Resolves when the server process exits. */
  waitForExit(): Promise<number | null> {
    const child = this.#child;
    if (child === null) {
      return Promise.resolve(null);
    }
    if (child.exitCode !== null) {
      return Promise.resolve(child.exitCode);
    }
    return new Promise((resolve) =>
      child.once("exit", (code) => {
        resolve(code);
      }),
    );
  }

  /** Sends `stop` and waits for the server to save and exit, killing it after 30 s. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      return;
    }
    if (child.exitCode !== null) {
      return;
    }
    const exited = this.waitForExit();
    if (child.stdin !== null) {
      child.stdin.write("stop\n");
    } else {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }
}
