import { describe, expect, it } from "vitest";

import { CodeRunner, type CodeRunOptions } from "../../src/harness/code/code-runner.ts";
import { NullServerControl } from "../../src/minecraft/server-control/server-control.ts";
import { FakeGame } from "../fakes/fake-game.ts";

function options(game: FakeGame, overrides: Partial<CodeRunOptions> = {}): CodeRunOptions {
  return {
    game,
    server: new NullServerControl(),
    agentName: "Sol",
    commands: false,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    progress: () => undefined,
    ...overrides,
  };
}

describe("CodeRunner", () => {
  it("returns logs and the returned value, and keeps state between calls", async () => {
    const game = new FakeGame();
    const runner = new CodeRunner(true);
    const first = await runner.run("state.count = 41; log('set', state.count); return { ok: true };", options(game));
    expect(first.ok).toBe(true);
    expect(first.logs).toEqual(["set 41"]);
    expect(first.returned).toBe('{"ok":true}');
    const second = await runner.run("return state.count + 1;", options(game));
    expect(second.returned).toBe("42");
    runner.reset();
    expect((await runner.run("return state.count ?? 'gone';", options(game))).returned).toBe("gone");
  });

  it("lets code use the skills library against the world", async () => {
    const game = new FakeGame();
    const result = await new CodeRunner(true).run(
      "for (let x = 0; x < 3; x++) { await skills.placeBlock(x, 64, 0, 'stone'); }\nreturn skills.blockAt(2, 64, 0).name;",
      options(game),
    );
    expect(result.returned).toBe("stone");
    expect(game.world.get({ x: 1, y: 64, z: 0 }).name).toBe("stone");
  });

  it("has no skills in raw mode", async () => {
    const result = await new CodeRunner(false).run("return typeof skills;", options(new FakeGame()));
    expect(result.returned).toBe("undefined");
  });

  it("reports syntax errors before running", async () => {
    const result = await new CodeRunner(true).run("log('a');\nconst = 1;", options(new FakeGame()));
    expect(result.ok).toBe(false);
    expect(result.logs).toEqual([]);
    expect(result.error).toMatch(/^SyntaxError: .*\(line 2\)/);
  });

  it("reports runtime errors with the line number", async () => {
    const result = await new CodeRunner(true).run("const a = 1;\nnull.boom;", options(new FakeGame()));
    expect(result.error).toMatch(/TypeError: .*\(line 2\)/);
  });

  it("cancels code that runs past its time limit", async () => {
    const result = await new CodeRunner(true).run(
      "while (true) { await sleep(50); }",
      options(new FakeGame(), { timeoutMs: 300 }),
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("stops synchronous loops that would freeze the bot", async () => {
    const result = await new CodeRunner(true).run(
      "let i = 0; while (true) { i++; }",
      options(new FakeGame(), { timeoutMs: 10_000 }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/without awaiting/);
  }, 15_000);

  it("stops when the owner aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await new CodeRunner(true).run(
      "await sleep(10000);",
      options(new FakeGame(), { signal: controller.signal }),
    );
    expect(result.cancelled).toBe(true);
  });

  it("removes bot listeners the code added", async () => {
    const game = new FakeGame();
    await new CodeRunner(true).run("bot.on('chat', () => log('heard'));", options(game));
    expect((game.bot as unknown as NodeJS.EventEmitter).listenerCount("chat")).toBe(0);
  });

  it("blocks eval and new Function inside the code", async () => {
    const result = await new CodeRunner(true).run("return eval('1 + 1');", options(new FakeGame()));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EvalError|Code generation/);
  });
});
