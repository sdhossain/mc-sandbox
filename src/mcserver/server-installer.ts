import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

import { LabError } from "../utils/errors.ts";
import { offlineUuid } from "./offline-uuid.ts";
import { ServerProperties } from "./server-properties.ts";

const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
export const EULA_URL = "https://aka.ms/MinecraftEULA";

/** What `server setup` should do. */
export interface ServerSetupOptions {
  /** The server folder, for example `server`. */
  readonly directory: string;
  /** Minecraft version, for example `1.21.11`. */
  readonly version: string;
  /** Players to make operators (level 4), by offline UUID. */
  readonly operators: readonly string[];
  /** Write `eula=true`. Only when the person running the setup has agreed to the Minecraft EULA. */
  readonly acceptEula: boolean;
  /** Generate a superflat world when no world exists yet. */
  readonly flat?: boolean;
  /** World seed when no world exists yet. */
  readonly seed?: string;
  readonly port?: number;
  readonly rconPort?: number;
}

/** What `server setup` did. */
export interface ServerSetupReport {
  readonly jar: "downloaded" | "already present";
  readonly eulaAccepted: boolean;
  readonly rconPassword: string;
  readonly operators: readonly { name: string; uuid: string }[];
}

interface VersionDownload {
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
}

/**
 * Prepares a local vanilla server for the lab: downloads Mojang's server jar (checking its SHA-1),
 * writes the server.properties the lab needs, seeds `ops.json`, and records EULA acceptance only when
 * asked to.
 *
 * Settings the lab needs: offline mode (bots have no Microsoft account), bound to 127.0.0.1 so no one
 * else can join an offline-mode server, no spawn protection, flight allowed (creative bots), and RCON
 * with a random password for the lab's operator channel.
 */
export class ServerInstaller {
  readonly #options: ServerSetupOptions;

  /** @param options - Where and what to set up. */
  constructor(options: ServerSetupOptions) {
    this.#options = options;
  }

  /** Runs every setup step. Safe to run again; existing settings and worlds are kept. */
  async setup(): Promise<ServerSetupReport> {
    const { directory } = this.#options;
    mkdirSync(directory, { recursive: true });
    const jar = await this.#ensureJar();
    const rconPassword = this.#writeProperties();
    const operators = this.#writeOps();
    const eulaAccepted = this.#writeEula();
    return { jar, eulaAccepted, rconPassword, operators };
  }

  async #ensureJar(): Promise<"downloaded" | "already present"> {
    const download = await this.#findDownload();
    const jarPath = join(this.#options.directory, "server.jar");
    if (existsSync(jarPath) && (await sha1Of(jarPath)) === download.sha1) {
      return "already present";
    }
    const partial = `${jarPath}.part`;
    const response = await fetch(download.url);
    if (!response.ok || response.body === null) {
      throw new LabError(`Downloading the server jar failed: HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const actual = await sha1Of(partial);
    if (actual !== download.sha1) {
      rmSync(partial, { force: true });
      throw new LabError(`The downloaded server jar has SHA-1 ${actual}, expected ${download.sha1}. Try again.`);
    }
    renameSync(partial, jarPath);
    return "downloaded";
  }

  async #findDownload(): Promise<VersionDownload> {
    const manifest = (await fetchJson(VERSION_MANIFEST_URL)) as { versions?: { id: string; url: string }[] };
    const entry = manifest.versions?.find((version) => version.id === this.#options.version);
    if (entry === undefined) {
      throw new LabError(`Minecraft ${this.#options.version} is not in Mojang's version manifest.`);
    }
    const details = (await fetchJson(entry.url)) as { downloads?: { server?: VersionDownload } };
    const server = details.downloads?.server;
    if (server === undefined) {
      throw new LabError(`Mojang publishes no server jar for ${this.#options.version}.`);
    }
    return server;
  }

  /** Writes the lab's settings into server.properties and returns the RCON password. */
  #writeProperties(): string {
    const path = join(this.#options.directory, "server.properties");
    const properties = ServerProperties.read(path);
    const password = properties.get("rcon.password") ?? "";
    const rconPassword = password === "" ? randomBytes(18).toString("base64url") : password;
    const settings: Record<string, string | number | boolean> = {
      "online-mode": false,
      "server-ip": "127.0.0.1",
      "server-port": this.#options.port ?? 25565,
      "spawn-protection": 0,
      "allow-flight": true,
      "enforce-secure-profile": false,
      "enable-rcon": true,
      "rcon.port": this.#options.rconPort ?? 25575,
      "rcon.password": rconPassword,
      "broadcast-rcon-to-ops": false,
      "level-name": "world",
      motd: "Minecraft harness lab",
    };
    const worldExists = existsSync(join(this.#options.directory, "world", "level.dat"));
    if (!worldExists && this.#options.flat === true) {
      settings["level-type"] = "minecraft:flat";
    }
    if (!worldExists && this.#options.seed !== undefined) {
      settings["level-seed"] = this.#options.seed;
    }
    for (const [key, value] of Object.entries(settings)) {
      properties.set(key, value);
    }
    properties.write(path);
    return rconPassword;
  }

  /** Adds the operators to ops.json by offline UUID, keeping existing entries. */
  #writeOps(): { name: string; uuid: string }[] {
    const path = join(this.#options.directory, "ops.json");
    const existing = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { uuid: string; name: string }[])
      : [];
    const operators = this.#options.operators.map((name) => ({ name, uuid: offlineUuid(name) }));
    const merged = [...existing.filter((entry) => !operators.some((op) => op.uuid === entry.uuid))];
    for (const operator of operators) {
      merged.push({ ...operator, level: 4, bypassesPlayerLimit: false } as { uuid: string; name: string });
    }
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
    return operators;
  }

  /** Writes eula.txt; `eula=true` only with explicit acceptance. Returns whether the EULA is accepted. */
  #writeEula(): boolean {
    const path = join(this.#options.directory, "eula.txt");
    const alreadyAccepted = existsSync(path) && /^eula=true$/m.test(readFileSync(path, "utf8"));
    if (alreadyAccepted) {
      return true;
    }
    const accepted = this.#options.acceptEula;
    writeFileSync(
      path,
      `# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (${EULA_URL}).\neula=${accepted ? "true" : "false"}\n`,
    );
    return accepted;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new LabError(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function sha1Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });
}
