import { Socket } from "node:net";

import { errorMessage, LabError } from "../../utils/errors.ts";

/** RCON packet types (Source RCON protocol, as implemented by the vanilla server). */
const PacketType = { RESPONSE: 0, COMMAND: 2, LOGIN: 3 } as const;
const HEADER_BYTES = 12;
const REQUEST_TIMEOUT_MS = 10_000;
/** The vanilla server rejects command packets larger than this. */
const MAX_COMMAND_BYTES = 1_446;

interface Pending {
  readonly resolve: (body: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Encodes one RCON packet: length, request id, type, body, two terminating zero bytes. */
export function encodePacket(requestId: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(HEADER_BYTES + payload.length + 2);
  packet.writeInt32LE(packet.length - 4, 0);
  packet.writeInt32LE(requestId, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, HEADER_BYTES);
  return packet;
}

/** Decodes every complete packet at the start of `buffer`; returns them and the unconsumed rest. */
export function decodePackets(buffer: Buffer): {
  packets: { requestId: number; type: number; body: string }[];
  rest: Buffer;
} {
  const packets: { requestId: number; type: number; body: string }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset);
    if (buffer.length - offset - 4 < length) {
      break;
    }
    const requestId = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.toString("utf8", offset + HEADER_BYTES, offset + 4 + length - 2);
    packets.push({ requestId, type, body });
    offset += 4 + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/**
 * A minimal RCON client for the vanilla server: log in, send commands one at a time, read replies.
 *
 * When the connection drops, for example because the server restarted, the next command connects and
 * logs in again; a command that was waiting for its reply when the connection dropped fails.
 */
export class RconClient {
  readonly #host: string;
  readonly #port: number;
  readonly #password: string;
  readonly #pending = new Map<number, Pending>();
  #socket: Socket | null = null;
  /** Set by {@link close}, after which there is no reconnecting. */
  #closed = false;
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @param host - Server host, usually 127.0.0.1.
   * @param port - `rcon.port` from server.properties.
   * @param password - `rcon.password` from server.properties.
   */
  constructor(host: string, port: number, password: string) {
    this.#host = host;
    this.#port = port;
    this.#password = password;
  }

  /** Connects and logs in. @throws LabError when the server is unreachable or the password is wrong. */
  async connect(): Promise<void> {
    const socket = new Socket();
    this.#socket = socket;
    this.#buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      this.#onData(chunk);
    });
    // Commands run one at a time, so only the current socket can have a request waiting. Events from a
    // socket that has been replaced (its "close" can come late) must not fail the new socket's request.
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#failAll(new LabError("RCON connection closed"));
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", (error) => {
          reject(new LabError(`Cannot reach RCON at ${this.#host}:${this.#port}: ${error.message}`));
        });
        // A socket destroyed while it connects, by close(), emits only "close".
        socket.once("close", () => {
          reject(new LabError(`Cannot reach RCON at ${this.#host}:${this.#port}: the connection was closed`));
        });
        socket.connect(this.#port, this.#host, () => {
          resolve();
        });
      });
      socket.on("error", (error) => {
        if (this.#socket === socket) {
          this.#failAll(new LabError(`RCON error: ${error.message}`));
        }
      });
      const loginId = this.#nextId++;
      const reply = this.#await(loginId, true);
      socket.write(encodePacket(loginId, PacketType.LOGIN, this.#password));
      await reply;
    } catch (error) {
      // Not connected or not logged in: drop the socket now, so that the next command starts over.
      if (this.#socket === socket) {
        this.#socket = null;
      }
      socket.destroy();
      throw error;
    }
  }

  /**
   * Runs a command (no leading slash) and returns the server's reply. Commands are sent one at a time.
   * After a dropped connection, it first connects again.
   *
   * @throws LabError when the server cannot be reached, the reply does not come within 10 s, or the
   *   connection drops before it does.
   */
  command(command: string): Promise<string> {
    const run = async (): Promise<string> => {
      if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
        throw new LabError(
          `Command too long for RCON (${Buffer.byteLength(command)} bytes, limit ${MAX_COMMAND_BYTES})`,
        );
      }
      const socket = await this.#openSocket();
      const id = this.#nextId++;
      const reply = this.#await(id, false);
      socket.write(encodePacket(id, PacketType.COMMAND, command));
      return reply;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Closes the connection for good. A command still waiting for its reply fails. */
  close(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#failAll(new LabError("RCON connection closed"));
    if (socket === null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      socket.end(() => {
        resolve();
      });
      socket.destroy();
    });
  }

  /** The logged-in socket, connecting again first when the last one closed or is closing. */
  async #openSocket(): Promise<Socket> {
    if (this.#socket !== null && (this.#socket.destroyed || !this.#socket.writable)) {
      // The server hung up; its "close" event has not arrived yet.
      this.#socket = null;
    }
    if (this.#socket === null) {
      if (this.#closed) {
        throw new LabError("RCON is closed");
      }
      try {
        await this.connect();
      } catch (error) {
        throw new LabError(
          this.#isClosed()
            ? "RCON is closed"
            : `RCON is not connected (is the server running?): ${errorMessage(error)}`,
        );
      }
    }
    if (this.#socket === null) {
      throw new LabError("RCON connection closed");
    }
    return this.#socket;
  }

  /** Reads the flag afresh: close() may have run during an await, which the type checker does not see. */
  #isClosed(): boolean {
    return this.#closed;
  }

  #await(id: number, isLogin: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new LabError(`RCON request timed out after ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve,
        reject: (error) => {
          reject(error);
        },
        timer,
      });
      if (isLogin) {
        // A failed login is answered with request id -1, which matches no pending entry.
        this.#pending.set(-1, {
          resolve: () => {
            this.#pending.delete(id);
            clearTimeout(timer);
            reject(new LabError("RCON login failed: wrong rcon.password"));
          },
          reject,
          timer,
        });
      }
    });
  }

  #onData(chunk: Buffer): void {
    const { packets, rest } = decodePackets(Buffer.concat([this.#buffer, chunk]));
    this.#buffer = rest;
    for (const packet of packets) {
      const pending = this.#pending.get(packet.requestId);
      if (pending === undefined) {
        continue;
      }
      this.#pending.delete(packet.requestId);
      this.#pending.delete(-1);
      clearTimeout(pending.timer);
      pending.resolve(packet.body);
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
