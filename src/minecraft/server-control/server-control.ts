import type { GameMode } from "../../utils/names.ts";

/**
 * The lab's operator channel to the server, separate from any bot.
 *
 * The lab uses it to set the scene (game mode, teleport, time), to show a status line on the owner's
 * screen, and to run commands for agents that have the `commands` privilege. Bots are never made
 * operators, so a model can only use commands through the `run_command` tool, which this class backs.
 *
 * Subclasses implement {@link run}; the helpers build on it.
 */
export abstract class ServerControl {
  /** False when no operator channel is configured; helpers then do nothing and {@link run} throws. */
  abstract readonly available: boolean;

  /**
   * Runs a server command and returns the server's reply text.
   *
   * @param command - The command without a leading slash, for example `time set day`.
   */
  abstract run(command: string): Promise<string>;

  /** Closes the channel. */
  abstract close(): Promise<void>;

  /** Runs `command` as `player`, positioned at `player`, so `~ ~ ~` and `@s` refer to that player. */
  runAs(player: string, command: string): Promise<string> {
    return this.run(`execute as ${player} at ${player} run ${command.replace(/^\//, "")}`);
  }

  /** Puts `player` in `mode`. */
  async setGameMode(player: string, mode: GameMode): Promise<void> {
    await this.run(`gamemode ${mode} ${player}`);
  }

  /** Teleports `player` to `target`, another player. */
  async teleportToPlayer(player: string, target: string): Promise<void> {
    await this.run(`tp ${player} ${target}`);
  }

  /** Shows `text` above `player`'s hotbar for a few seconds. Used as a quiet status line. */
  async actionBar(player: string, text: string): Promise<void> {
    await this.run(`title ${player} actionbar ${JSON.stringify({ text })}`);
  }

  /** Sends `player` a private system line, in grey, that does not go through public chat. */
  async tell(player: string, text: string): Promise<void> {
    await this.run(`tellraw ${player} ${JSON.stringify({ text, color: "gray" })}`);
  }
}

/** The stand-in used when the lab has no operator channel. Every command fails with an explanation. */
export class NullServerControl extends ServerControl {
  readonly available = false;

  /** Always throws: there is no channel to run the command on. */
  run(command: string): Promise<string> {
    return Promise.reject(
      new Error(`Cannot run "/${command}": the lab has no RCON connection to the server. See docs/setup.md, "RCON".`),
    );
  }

  /** Nothing to close. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Ignored without a channel, so a missing status line never breaks a run. */
  override actionBar(): Promise<void> {
    return Promise.resolve();
  }
}
