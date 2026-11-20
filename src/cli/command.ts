import { parseArgs, type ParseArgsConfig } from "node:util";

/** Parsed `--flag` values, as `node:util` returns them. */
export type Flags = Record<string, string | boolean | string[] | boolean[] | undefined>;

/** Base class for a CLI command: `mclab <name> [args]`. */
export abstract class Command {
  /** The word that selects the command. */
  abstract readonly name: string;
  /** One line for the help listing. */
  abstract readonly summary: string;
  /** Usage text shown by `--help`. */
  abstract readonly usage: string;
  /** Flags the command accepts. */
  protected abstract readonly options: NonNullable<ParseArgsConfig["options"]>;

  /** Parses `argv` and runs the command. Returns the process exit code. */
  async run(argv: readonly string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { ...this.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
    if (values.help === true) {
      console.log(this.usage);
      return 0;
    }
    return this.execute(values, positionals);
  }

  /** Does the work. */
  protected abstract execute(flags: Flags, positionals: readonly string[]): Promise<number>;
}

/** A string flag's value, or undefined. */
export function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** A boolean flag's value. */
export function booleanFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}
