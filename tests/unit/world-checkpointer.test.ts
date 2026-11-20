import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorldCheckpointer } from "../../src/mcserver/world-checkpointer.ts";
import { NullServerControl, ServerControl } from "../../src/minecraft/server-control/server-control.ts";

/** Records the commands it is sent, and answers the game-time query. */
class RecordingServer extends ServerControl {
  readonly available = true;
  readonly commands: string[] = [];

  run(command: string): Promise<string> {
    this.commands.push(command);
    return Promise.resolve(command === "time query gametime" ? "The time is 4242" : "");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A small world folder: level.dat, one region file and the server's lock file. */
function makeWorld(): { world: string; store: string } {
  const root = mkdtempSync(join(tmpdir(), "mclab-checkpoint-"));
  const world = join(root, "world");
  mkdirSync(join(world, "region"), { recursive: true });
  writeFileSync(join(world, "level.dat"), "level");
  writeFileSync(join(world, "region", "r.0.0.mca"), "chunks v1");
  writeFileSync(join(world, "session.lock"), "lock");
  return { world, store: join(root, "checkpoints") };
}

describe("WorldCheckpointer", () => {
  it("copies the world with autosave off, without the server's lock file", async () => {
    const { world, store } = makeWorld();
    const server = new RecordingServer();
    const info = await new WorldCheckpointer(server, world, store).save("lab start");
    expect(server.commands).toEqual(["save-off", "save-all flush", "time query gametime", "save-on"]);
    expect(info.id).toMatch(/^\d{8}-\d{6}_lab-start$/);
    expect(info.gameTime).toBe(4242);
    expect(existsSync(join(info.worldPath, "level.dat"))).toBe(true);
    expect(existsSync(join(info.worldPath, "region", "r.0.0.mca"))).toBe(true);
    expect(existsSync(join(info.worldPath, "session.lock"))).toBe(false);
    expect(info.copiedBytes).toBe("level".length + "chunks v1".length);
  });

  it("shares unchanged files with the previous checkpoint and copies changed ones", async () => {
    const { world, store } = makeWorld();
    const checkpoints = new WorldCheckpointer(new RecordingServer(), world, store);
    const first = await checkpoints.save("first");
    writeFileSync(join(world, "region", "r.0.0.mca"), "chunks v2!");
    utimesSync(join(world, "region", "r.0.0.mca"), new Date(), new Date(Date.now() + 5_000));
    const second = await checkpoints.save("second");
    expect(second.copiedBytes).toBe("chunks v2!".length);
    expect(second.linkedBytes).toBe("level".length);
    expect(statSync(join(second.worldPath, "level.dat")).ino).toBe(statSync(join(first.worldPath, "level.dat")).ino);
    expect(statSync(join(second.worldPath, "level.dat")).mode & 0o222).toBe(0); // read-only: shared between checkpoints
    expect(checkpoints.list().map((info) => info.label)).toEqual(["first", "second"]);
  });

  it("turns autosave back on when the copy fails", async () => {
    const { world, store } = makeWorld();
    chmodSync(join(world, "region", "r.0.0.mca"), 0o000);
    const server = new RecordingServer();
    await expect(new WorldCheckpointer(server, world, store).save("broken")).rejects.toThrow();
    expect(server.commands.at(-1)).toBe("save-on");
    chmodSync(join(world, "region", "r.0.0.mca"), 0o644);
  });

  it("never runs two saves at once", async () => {
    const { world, store } = makeWorld();
    const server = new RecordingServer();
    const checkpoints = new WorldCheckpointer(server, world, store);
    const [a, b] = await Promise.all([checkpoints.save("same"), checkpoints.save("same")]);
    expect(a.id).not.toBe(b.id);
    expect(server.commands.filter((command) => command.startsWith("save-"))).toEqual([
      "save-off",
      "save-all flush",
      "save-on",
      "save-off",
      "save-all flush",
      "save-on",
    ]);
  });

  it("opens a writable copy in a saves folder", async () => {
    const { world, store } = makeWorld();
    const checkpoints = new WorldCheckpointer(new RecordingServer(), world, store);
    const info = await checkpoints.save("view");
    const saves = mkdtempSync(join(tmpdir(), "mclab-saves-"));
    const folder = checkpoints.openCopy(info.id, saves);
    expect(statSync(join(folder, "level.dat")).mode & 0o200).not.toBe(0);
  });

  it("needs RCON", async () => {
    const { world, store } = makeWorld();
    await expect(new WorldCheckpointer(new NullServerControl(), world, store).save("x")).rejects.toThrow(/need RCON/);
  });
});
