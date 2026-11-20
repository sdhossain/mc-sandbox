#!/usr/bin/env node
/**
 * The `mclab` command line. Run with `npm run lab -- <command>` or `node src/cli/main.ts <command>`.
 */

import { existsSync } from "node:fs";

import "../harness/index.ts";
import "../llm/index.ts";
import { ConfigError, errorMessage, LabError } from "../utils/errors.ts";
import type { Command } from "./command.ts";
import { CheckpointCommand } from "./commands/checkpoint-command.ts";
import { DoctorCommand } from "./commands/doctor-command.ts";
import { CasesCommand, HarnessesCommand, ModelsCommand, RunsCommand } from "./commands/info-commands.ts";
import { LoadCommand } from "./commands/load-command.ts";
import { ServerCommand } from "./commands/server-command.ts";
import { StartCommand } from "./commands/start-command.ts";
import { TrialsCommand } from "./commands/trials-command.ts";

const COMMANDS: readonly Command[] = [
  new StartCommand(),
  new ServerCommand(),
  new DoctorCommand(),
  new ModelsCommand(),
  new HarnessesCommand(),
  new CasesCommand(),
  new CheckpointCommand(),
  new TrialsCommand(),
  new LoadCommand(),
  new RunsCommand(),
];

async function main(argv: readonly string[]): Promise<number> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const [name, ...rest] = argv;
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (command === undefined) {
    console.log("Usage: mclab <command> [--help]\n");
    for (const candidate of COMMANDS) {
      console.log(`  ${candidate.name.padEnd(10)} ${candidate.summary}`);
    }
    return name === undefined || name === "--help" || name === "-h" ? 0 : 1;
  }
  return command.run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const expected = error instanceof LabError || error instanceof ConfigError;
    console.error(expected ? `Error: ${errorMessage(error)}` : error);
    process.exitCode = 1;
  },
);
