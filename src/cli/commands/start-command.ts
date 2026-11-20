import { createInterface } from "node:readline";

import type { AgentConfig } from "../../agent/agent-config.ts";
import { ControlCommand } from "../../agent/chat-addressing.ts";
import { LabConfigSchema, type LabConfig } from "../../config/lab-config.ts";
import { loadLabConfig, loadModelCatalog, validate } from "../../config/load-config.ts";
import { Lab } from "../../lab/lab.ts";
import { DashboardServer } from "../../observability/dashboard/dashboard-server.ts";
import { ConfigError, errorMessage } from "../../utils/errors.ts";
import { MessageSource } from "../../utils/names.ts";
import { booleanFlag, Command, stringFlag, type Flags } from "../command.ts";

/** `mclab start`: connect the agents and run until Ctrl-C. */
export class StartCommand extends Command {
  readonly name = "start";
  readonly summary = "Start the agents from configs/lab.yaml and the live dashboard";
  readonly usage = `Usage: mclab start [flags]

Starts every agent in configs/lab.yaml (or only those named with --agent). Flags override the config
for the selected agents:
  --config <path>         Lab config (default configs/lab.yaml)
  --agent <name>          Start only this agent (repeatable)
  --name <name>           Rename the bot (only with a single agent)
  --model <id>            Model preset from configs/models.yaml, e.g. gpt-6.2-sol
  --harness <preset>      Harness preset from configs/harnesses, e.g. primitive, skills, code, code-commands
  --game-mode <mode>      survival or creative
  --no-dashboard          Do not start the web dashboard
  --verbose               Print model text and full tool output

While running, type in this terminal to talk to the agent:  <message>, or !stop, !reset, !status.
With several agents, start with a name: "Sol, build a wall".`;
  protected readonly options = {
    config: { type: "string" },
    agent: { type: "string", multiple: true },
    name: { type: "string" },
    model: { type: "string" },
    harness: { type: "string" },
    "game-mode": { type: "string" },
    "no-dashboard": { type: "boolean" },
    verbose: { type: "boolean" },
  } as const;

  protected async execute(flags: Flags): Promise<number> {
    const config = applyOverrides(loadLabConfig(stringFlag(flags, "config")), flags);
    const lab = await Lab.open(config, { models: loadModelCatalog(), verbose: booleanFlag(flags, "verbose") });
    const dashboard =
      config.dashboard.enabled && !booleanFlag(flags, "no-dashboard")
        ? new DashboardServer(lab, config.dashboard)
        : null;
    let shuttingDown = false;
    const shutdown = async (exitCode = 0): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      console.log("\nShutting down: ending runs and disconnecting...");
      await dashboard?.close();
      await lab.shutdown();
      process.exit(exitCode);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    await dashboard?.listen();
    try {
      await lab.start();
    } catch (error) {
      console.error(`Could not start: ${errorMessage(error)}`);
      await shutdown(1);
      return 1;
    }
    console.log(
      `\n${lab.agents.map((agent) => agent.name).join(", ")} joined. Talk to them in Minecraft chat, or type here.`,
    );
    if (dashboard !== null) {
      console.log(`Dashboard: ${dashboard.url}`);
    }
    this.#readTerminal(lab, config.owners[0] ?? "owner");
    await new Promise(() => undefined);
    return 0;
  }

  /** Lets the person at the terminal message the agents as the first owner. */
  #readTerminal(lab: Lab, owner: string): void {
    if (!process.stdin.isTTY) {
      return;
    }
    const reader = createInterface({ input: process.stdin });
    reader.on("line", (line) => {
      const text = line.trim();
      if (text === "") {
        return;
      }
      const match = /^@?(\w{3,16})[,:]\s+(.*)$/s.exec(text);
      const target = match === null ? undefined : lab.agent(match[1] ?? "");
      const agents = target === undefined ? lab.agents : [target];
      const body = target === undefined ? text : (match?.[2] ?? "");
      for (const agent of agents) {
        const [, name, argument = ""] = /^!(\w+)\s*(.*)$/s.exec(body) ?? [];
        const control = name?.toLowerCase();
        if (control !== undefined && (Object.values(ControlCommand) as string[]).includes(control)) {
          void agent.control(control as ControlCommand, owner, MessageSource.CLI, argument).then((answer) => {
            console.log(`[${agent.name}] ${answer}`);
          });
        } else {
          agent.submit({ source: MessageSource.CLI, from: owner, text: body, receivedAtMs: Date.now() });
        }
      }
    });
  }
}

/** Applies command-line overrides to the selected agents and re-validates. */
export function applyOverrides(config: LabConfig, flags: Flags): LabConfig {
  const selected = flags.agent;
  let agents: AgentConfig[] = config.agents;
  if (Array.isArray(selected) && selected.length > 0) {
    const wanted = new Set(selected.map((name) => String(name).toLowerCase()));
    agents = agents.filter((agent) => wanted.has(agent.name.toLowerCase()));
    if (agents.length === 0) {
      throw new ConfigError(`No agent named ${selected.join(", ")} in the lab config.`);
    }
  }
  const name = stringFlag(flags, "name");
  if (name !== undefined && agents.length !== 1) {
    throw new ConfigError("--name works only when exactly one agent is started (use --agent to pick one).");
  }
  const gameMode = stringFlag(flags, "game-mode");
  const model = stringFlag(flags, "model");
  const harness = stringFlag(flags, "harness");
  const overridden = agents.map((agent) => ({
    ...agent,
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(harness === undefined ? {} : { harness }),
    privileges: {
      ...agent.privileges,
      ...(gameMode === undefined ? {} : { gameMode }),
    },
  }));
  return validate(LabConfigSchema, { ...config, agents: overridden }, "command-line flags");
}
