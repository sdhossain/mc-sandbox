import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { decodePackets, encodePacket, RconClient } from "../../src/minecraft/server-control/rcon-client.ts";
import { sleep } from "../../src/utils/abort.ts";

/** A fake RCON server that accepts one password and echoes commands. */
interface FakeServer {
  readonly port: number;
  /** Drops every connection and stops listening, as a server that shuts down does. */
  stop(): Promise<void>;
}

/** Starts a {@link FakeServer} on `port`, or on a free port when it is 0. */
function startFakeServer(password: string, port = 0): Promise<FakeServer> {
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const { packets, rest } = decodePackets(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const packet of packets) {
        if (packet.type === 3) {
          socket.write(encodePacket(packet.body === password ? packet.requestId : -1, 2, ""));
        } else {
          socket.write(encodePacket(packet.requestId, 0, `ran: ${packet.body}`));
        }
      }
    });
  });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of connections) {
        socket.destroy();
      }
      server.close(() => {
        resolve();
      });
    });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address !== null ? address.port : 0, stop });
    });
  });
}

describe("RconClient", () => {
  let fake: FakeServer | undefined;
  afterEach(async () => {
    await fake?.stop();
    fake = undefined;
  });

  it("round-trips packets", () => {
    const { packets, rest } = decodePackets(Buffer.concat([encodePacket(7, 2, "time set day"), Buffer.from([1, 2])]));
    expect(packets).toEqual([{ requestId: 7, type: 2, body: "time set day" }]);
    expect(rest.length).toBe(2);
  });

  it("logs in and runs commands in order", async () => {
    fake = await startFakeServer("secret");
    const client = new RconClient("127.0.0.1", fake.port, "secret");
    await client.connect();
    const replies = await Promise.all([client.command("list"), client.command("time set day")]);
    expect(replies).toEqual(["ran: list", "ran: time set day"]);
    await client.close();
  });

  it("rejects a wrong password", async () => {
    fake = await startFakeServer("secret");
    const client = new RconClient("127.0.0.1", fake.port, "wrong");
    await expect(client.connect()).rejects.toThrow(/wrong rcon.password/);
    await client.close();
  });

  it("connects again on the next command after the server restarts", async () => {
    const first = await startFakeServer("secret");
    const client = new RconClient("127.0.0.1", first.port, "secret");
    await client.connect();
    expect(await client.command("list")).toBe("ran: list");

    await first.stop();
    await sleep(50);
    await expect(client.command("list")).rejects.toThrow(/RCON is not connected \(is the server running\?\)/);

    fake = await startFakeServer("secret", first.port);
    expect(await client.command("time set day")).toBe("ran: time set day");
    expect(await client.command("list")).toBe("ran: list");
    await client.close();
  });

  it("fails a command whose reconnect is cut short by close()", async () => {
    const client = new RconClient("127.0.0.1", 1, "secret");
    const command = client.command("list");
    // Let the command start connecting, then close the client while the socket is still connecting.
    await Promise.resolve();
    await client.close();
    await expect(command).rejects.toThrow(/RCON is closed/);
    await expect(client.command("list")).rejects.toThrow(/RCON is closed/);
  });

  it("does not connect again after it is closed", async () => {
    fake = await startFakeServer("secret");
    const client = new RconClient("127.0.0.1", fake.port, "secret");
    await client.connect();
    await client.close();
    await expect(client.command("list")).rejects.toThrow(/RCON is closed/);
  });
});
