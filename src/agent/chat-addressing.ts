/**
 * Decides which chat lines are meant for which agent, and which are control commands.
 *
 * Rules, for an agent named `Sol` with other agents online:
 * - `Sol build a farm`, `Sol, build a farm`, `Sol: build a farm`, `@Sol build a farm` address Sol.
 * - `@all build a farm` addresses every agent.
 * - A whisper (`/msg Sol build a farm`) addresses Sol.
 * - An unaddressed line addresses an agent only when it is the only agent in the lab.
 * Only configured owners can address agents; other players' lines are recorded but ignored.
 */

/** Control commands the owner can send. */
export const ControlCommand = {
  STOP: "stop",
  RESET: "reset",
  STATUS: "status",
  HELP: "help",
  /** Run a failure case: `!case <id>`, or `!case` to list them. */
  CASE: "case",
  /** Evaluate the running case's checks again now. */
  CHECK: "check",
  /** Save a copy of the whole world now: `!save [label]`. */
  SAVE: "save",
  /** Put a trial's saved end state into the world: `!load t7`; `!load` lists them, `!load <case id>` puts a case's start back. */
  LOAD: "load",
  /** Approve the agent's open request (items, in the skills-approval preset). */
  APPROVE: "approve",
  /** Deny the agent's open request: `!deny <reason>`. */
  DENY: "deny",
} as const;
export type ControlCommand = (typeof ControlCommand)[keyof typeof ControlCommand];

/** A chat line interpreted for one agent. */
export type AddressedLine =
  | { readonly kind: "ignored" }
  | { readonly kind: "task"; readonly text: string }
  | { readonly kind: "control"; readonly command: ControlCommand; readonly argument: string };

/** Interprets chat lines for one agent. */
export class ChatAddressing {
  readonly #name: string;
  readonly #owners: ReadonlySet<string>;
  readonly #roster: () => readonly string[];

  /**
   * @param name - This agent's name.
   * @param owners - Players allowed to command agents.
   * @param roster - Names of all agents in the lab, read on every line because agents can join later.
   */
  constructor(name: string, owners: readonly string[], roster: () => readonly string[]) {
    this.#name = name;
    this.#owners = new Set(owners.map((owner) => owner.toLowerCase()));
    this.#roster = roster;
  }

  /** True when `username` may command agents. */
  isOwner(username: string): boolean {
    return this.#owners.has(username.toLowerCase());
  }

  /** Interprets one line from `username`. */
  interpret(username: string, text: string, whisper: boolean): AddressedLine {
    if (!this.isOwner(username)) {
      return { kind: "ignored" };
    }
    const body = whisper ? text.trim() : this.#stripAddress(text.trim());
    if (body === null || body.length === 0) {
      return { kind: "ignored" };
    }
    const control = /^!(\w+)\s*(.*)$/s.exec(body);
    if (control !== null) {
      const command = (control[1] ?? "").toLowerCase();
      if (isControlCommand(command)) {
        return { kind: "control", command, argument: (control[2] ?? "").trim() };
      }
    }
    return { kind: "task", text: body };
  }

  /** The line without its address prefix, or null when it is addressed to someone else. */
  #stripAddress(text: string): string | null {
    const match = /^@?([A-Za-z0-9_]{1,16})\s*[,:]?\s+(.*)$/s.exec(text);
    const prefix = match?.[1]?.toLowerCase();
    const rest = match?.[2] ?? "";
    if (prefix === this.#name.toLowerCase() || prefix === "all") {
      return rest;
    }
    const roster = this.#roster().map((name) => name.toLowerCase());
    if (prefix !== undefined && roster.includes(prefix)) {
      return null;
    }
    // Unaddressed: meant for this agent only if it is the only one.
    return roster.length <= 1 ? text : null;
  }
}

function isControlCommand(value: string): value is ControlCommand {
  return (Object.values(ControlCommand) as string[]).includes(value);
}
