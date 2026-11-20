import { join, resolve } from "node:path";

import { loadLabConfig } from "../../config/load-config.ts";
import { JavaLocator, REQUIRED_JAVA_MAJOR } from "../../mcserver/java-locator.ts";
import { EULA_URL, ServerInstaller } from "../../mcserver/server-installer.ts";
import { ServerProcess } from "../../mcserver/server-process.ts";
import { WorldImporter } from "../../mcserver/world-importer.ts";
import { LabError } from "../../utils/errors.ts";
import { booleanFlag, Command, stringFlag, type Flags } from "../command.ts";

/** `mclab server setup|start|import-world`: prepare and run the local vanilla server. */
export class ServerCommand extends Command {
  readonly name = "server";
  readonly summary = "Set up, import a world into, or start the local Minecraft server";
  readonly usage = `Usage:
  mclab server setup [--accept-eula] [--world <save folder>] [--flat] [--seed <seed>]
      Download the Minecraft server jar (checksum-verified) into the server folder, write server.properties
      (offline mode, 127.0.0.1 only, RCON), make the owners operators, and optionally copy a singleplayer
      save in as the world. --accept-eula records that you agree to the Minecraft EULA (${EULA_URL}).
  mclab server import-world <save folder>
      Copy a singleplayer save into the server (the original is not modified; an existing server world is backed up).
  mclab server start [--memory 4G]
      Run the server in this terminal. Type "stop" to stop it.

Common flags: --config <lab.yaml> (default configs/lab.yaml)`;
  protected readonly options = {
    config: { type: "string" },
    "accept-eula": { type: "boolean" },
    world: { type: "string" },
    flat: { type: "boolean" },
    seed: { type: "string" },
    memory: { type: "string" },
  } as const;

  protected async execute(flags: Flags, positionals: readonly string[]): Promise<number> {
    const config = loadLabConfig(stringFlag(flags, "config"));
    const directory = config.server.directory;
    const [action, argument] = positionals;
    switch (action) {
      case "setup":
        return this.#setup(flags, directory, config.server.version, config.owners, config.server.port);
      case "import-world":
        if (argument === undefined) {
          throw new LabError("Name the save folder: mclab server import-world <save folder>");
        }
        this.#import(directory, argument, config.owners[0] ?? null);
        return 0;
      case "start":
        return this.#start(directory, stringFlag(flags, "memory"));
      default:
        console.log(this.usage);
        return action === undefined ? 0 : 1;
    }
  }

  async #setup(
    flags: Flags,
    directory: string,
    version: string,
    owners: readonly string[],
    port: number,
  ): Promise<number> {
    console.log(`Setting up Minecraft ${version} in ${resolve(directory)} ...`);
    const seed = stringFlag(flags, "seed");
    const report = await new ServerInstaller({
      directory,
      version,
      operators: owners,
      acceptEula: booleanFlag(flags, "accept-eula"),
      flat: booleanFlag(flags, "flat"),
      port,
      ...(seed === undefined ? {} : { seed }),
    }).setup();
    console.log(`Server jar: ${report.jar}.`);
    console.log(`Operators: ${report.operators.map((op) => `${op.name} (${op.uuid})`).join(", ")}.`);
    console.log(
      `RCON enabled on 127.0.0.1 with a random password (stored in ${join(directory, "server.properties")}).`,
    );
    const world = stringFlag(flags, "world");
    if (world !== undefined) {
      this.#import(directory, world, owners[0] ?? null);
    }
    if (!report.eulaAccepted) {
      console.log(
        `\nThe server will not start until you accept the Minecraft EULA: read ${EULA_URL}, then run\n  npm run server:setup -- --accept-eula`,
      );
    }
    const java = new JavaLocator().find();
    console.log(
      java === null
        ? `\nNo Java ${REQUIRED_JAVA_MAJOR}+ found. Install it (macOS: brew install openjdk@21).`
        : `\nJava ${java.major}: ${java.path} (${java.source}).`,
    );
    console.log("\nNext: npm run server");
    return 0;
  }

  #import(directory: string, savePath: string, owner: string | null): void {
    const report = new WorldImporter(directory).import(savePath, owner);
    console.log(`Copied ${report.source} to ${report.destination}.`);
    if (report.backup !== null) {
      console.log(`The previous server world was moved to ${report.backup}.`);
    }
    if (report.playerData !== null) {
      console.log(
        `Player data ${report.playerData.from} copied to ${owner ?? ""}'s offline UUID ${report.playerData.to}, so your inventory and position carry over.`,
      );
    }
  }

  async #start(directory: string, memory: string | undefined): Promise<number> {
    const java = new JavaLocator().find();
    if (java === null) {
      throw new LabError(
        `No Java ${REQUIRED_JAVA_MAJOR}+ found. Install it (macOS: brew install openjdk@21) or set JAVA_HOME.`,
      );
    }
    console.log(`Starting the server with Java ${java.major} (${java.source}). Type "stop" to stop it.`);
    const server = new ServerProcess({
      directory,
      javaPath: java.path,
      interactive: true,
      ...(memory === undefined ? {} : { memory }),
    });
    process.once("SIGINT", () => {
      void server.stop();
    });
    await server.start(600_000);
    console.log(`\nServer ready. Join with Multiplayer > Direct Connection > localhost, then run: npm start`);
    return (await server.waitForExit()) ?? 0;
  }
}
