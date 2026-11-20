import { RconClient } from "./rcon-client.ts";
import { ServerControl } from "./server-control.ts";

/** {@link ServerControl} over the vanilla server's RCON port. */
export class RconServerControl extends ServerControl {
  readonly available = true;
  readonly #client: RconClient;

  /** @param client - A connected, logged-in RCON client. */
  constructor(client: RconClient) {
    super();
    this.#client = client;
  }

  /**
   * Connects and logs in.
   *
   * @throws LabError when RCON is unreachable or the password is wrong.
   */
  static async connect(host: string, port: number, password: string): Promise<RconServerControl> {
    const client = new RconClient(host, port, password);
    await client.connect();
    return new RconServerControl(client);
  }

  /** Runs a command and returns the server's reply, reconnecting first if the server restarted. */
  run(command: string): Promise<string> {
    return this.#client.command(command.replace(/^\//, ""));
  }

  /** Closes the RCON connection. */
  close(): Promise<void> {
    return this.#client.close();
  }
}
