import { describe, expect, it } from "vitest";

import { ApprovalDesk } from "../../src/agent/approval-desk.ts";
import { ServerControl } from "../../src/minecraft/server-control/server-control.ts";
import type { ToolContext } from "../../src/tools/tool.ts";
import { RequestItemsTool } from "../../src/tools/inventory/request-items-tool.ts";
import { FakeGame } from "../fakes/fake-game.ts";

/** Runs `give` commands against the fake game's inventory and records every command. */
class GivingServer extends ServerControl {
  readonly available = true;
  readonly commands: string[] = [];
  readonly inventory = new Map<string, number>();

  run(command: string): Promise<string> {
    this.commands.push(command);
    const [, , item = "", count = "0"] = command.split(" ");
    this.inventory.set(item, (this.inventory.get(item) ?? 0) + Number(count));
    return Promise.resolve(`Gave ${count} [${item}] to Sol`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function contextFor(desk: ApprovalDesk): { context: ToolContext; server: GivingServer } {
  const game = new FakeGame();
  const server = new GivingServer();
  game.inventory.count = (name) => server.inventory.get(name) ?? 0;
  const context: ToolContext = {
    agentName: "Sol",
    game,
    server,
    privileges: { gameMode: "survival" },
    signal: new AbortController().signal,
    callId: "call_1",
    runDir: ".",
    approvals: desk,
    progress: () => undefined,
  };
  return { context, server };
}

const request = {
  items: [
    { item: "oak_planks", count: 20 },
    { item: "glass", count: 4 },
  ],
  reason: "for the hut",
};

describe("RequestItemsTool", () => {
  it("gives the items at once in automatic mode", async () => {
    const { context, server } = contextFor(new ApprovalDesk(() => Promise.reject(new Error("must not ask"))));
    const result = await new RequestItemsTool("automatic").execute(request, context);
    expect(server.commands).toEqual(["give Sol oak_planks 20", "give Sol glass 4"]);
    expect(result.output).toBe("Received 20 oak_planks, 4 glass.");
  });

  it("asks the owner and gives the items once approved", async () => {
    const asked: string[] = [];
    const desk = new ApprovalDesk((question) => {
      asked.push(question);
      setTimeout(() => desk.answer({ approved: true, by: "Owner", note: "" }), 10);
      return Promise.resolve();
    });
    const { context, server } = contextFor(desk);
    const result = await new RequestItemsTool("approval").execute(request, context);
    expect(asked[0]).toContain("Sol asks for 20 oak_planks, 4 glass (for the hut)");
    expect(server.commands).toHaveLength(2);
    expect(result.output).toBe("Owner approved. Received 20 oak_planks, 4 glass.");
  });

  it("gives nothing when the owner denies", async () => {
    const desk = new ApprovalDesk(() => {
      setTimeout(() => desk.answer({ approved: false, by: "Owner", note: "gather them yourself" }), 10);
      return Promise.resolve();
    });
    const { context, server } = contextFor(desk);
    const result = await new RequestItemsTool("approval").execute(request, context);
    expect(server.commands).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/^Owner denied the request: gather them yourself\./);
  });
});
