import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";

import { listHarnessPresets, loadHarnessPreset, loadLabConfig, loadModelCatalog } from "../../config/load-config.ts";
import { JavaLocator, REQUIRED_JAVA_MAJOR } from "../../mcserver/java-locator.ts";
import { ServerProperties } from "../../mcserver/server-properties.ts";
import { RconServerControl } from "../../minecraft/server-control/rcon-server-control.ts";
import { errorMessage } from "../../utils/errors.ts";
import { Command, stringFlag, type Flags } from "../command.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** `mclab doctor`: checks everything the lab needs and says how to fix what is missing. */
export class DoctorCommand extends Command {
  readonly name = "doctor";
  readonly summary = "Check Node, Java, the server folder, RCON, configs and API keys";
  readonly usage = "Usage: mclab doctor [--config <lab.yaml>]";
  protected readonly options = { config: { type: "string" } } as const;

  protected async execute(flags: Flags): Promise<number> {
    const checks: Check[] = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "Node.js", ok: nodeMajor >= 24, detail: `${process.version} (need 24 or newer)` });

    const java = new JavaLocator().find();
    checks.push({
      name: "Java",
      ok: java !== null,
      detail:
        java === null
          ? `no Java ${REQUIRED_JAVA_MAJOR}+ found (macOS: brew install openjdk@21)`
          : `Java ${java.major} from ${java.source}`,
    });

    let config;
    try {
      config = loadLabConfig(stringFlag(flags, "config"));
      checks.push({
        name: "Lab config",
        ok: true,
        detail: `owners ${config.owners.join(", ")}; agents ${config.agents.map((a) => `${a.name} (${a.model}, ${a.harness})`).join(", ")}`,
      });
    } catch (error) {
      checks.push({ name: "Lab config", ok: false, detail: errorMessage(error) });
    }

    try {
      const models = loadModelCatalog();
      checks.push({ name: "Model presets", ok: true, detail: [...models.keys()].join(", ") });
      for (const agent of config?.agents ?? []) {
        const model = models.get(agent.model);
        const keyName = (model as { apiKeyEnv?: string } | undefined)?.apiKeyEnv;
        if (model === undefined) {
          checks.push({ name: `Model for ${agent.name}`, ok: false, detail: `unknown model ${agent.model}` });
        } else if (keyName !== undefined) {
          const present = (process.env[keyName] ?? "") !== "";
          checks.push({
            name: `API key for ${agent.name}`,
            ok: present,
            detail: present ? `${keyName} is set` : `${keyName} is not set (put it in .env)`,
          });
        }
      }
    } catch (error) {
      checks.push({ name: "Model presets", ok: false, detail: errorMessage(error) });
    }

    for (const preset of listHarnessPresets()) {
      try {
        loadHarnessPreset(preset);
        checks.push({ name: `Harness preset ${preset}`, ok: true, detail: "valid" });
      } catch (error) {
        checks.push({ name: `Harness preset ${preset}`, ok: false, detail: errorMessage(error) });
      }
    }

    if (config !== undefined) {
      const directory = config.server.directory;
      const hasJar = existsSync(join(directory, "server.jar"));
      checks.push({
        name: "Server jar",
        ok: hasJar,
        detail: hasJar ? join(directory, "server.jar") : "missing: npm run server:setup",
      });
      const eulaPath = join(directory, "eula.txt");
      const eula = existsSync(eulaPath) && /^eula=true$/m.test(readFileSync(eulaPath, "utf8"));
      checks.push({
        name: "EULA",
        ok: eula,
        detail: eula ? "accepted" : "not accepted: npm run server:setup -- --accept-eula",
      });
      const properties = ServerProperties.read(join(directory, "server.properties"));
      const offline = properties.get("online-mode") === "false";
      checks.push({
        name: "Offline mode",
        ok: offline,
        detail: offline ? "online-mode=false" : "bots need online-mode=false: npm run server:setup",
      });
      const listening = await isListening(config.server.host, config.server.port);
      checks.push({
        name: "Server running",
        ok: listening,
        detail: listening
          ? `${config.server.host}:${config.server.port} is accepting connections`
          : "not running: npm run server",
      });
      if (listening) {
        const password = config.server.rcon.password ?? properties.get("rcon.password");
        const port = config.server.rcon.port ?? Number(properties.get("rcon.port") ?? 25575);
        try {
          const rcon = await RconServerControl.connect(
            config.server.rcon.host ?? config.server.host,
            port,
            password ?? "",
          );
          const players = await rcon.run("list");
          await rcon.close();
          checks.push({ name: "RCON", ok: true, detail: players });
        } catch (error) {
          checks.push({ name: "RCON", ok: false, detail: errorMessage(error) });
        }
      }
    }

    for (const check of checks) {
      console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }
}

function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1_500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}
