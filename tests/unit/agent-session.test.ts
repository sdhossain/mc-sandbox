import { describe, expect, it } from "vitest";

import "../../src/harness/index.ts";
import { AgentSession } from "../../src/agent/agent-session.ts";
import { ApprovalDesk } from "../../src/agent/approval-desk.ts";
import type { OwnerMessage } from "../../src/agent/inbox.ts";
import { HarnessConfigSchema } from "../../src/harness/harness.ts";
import { PrimitiveHarness } from "../../src/harness/primitive/primitive-harness.ts";
import { ScriptedModel, ScriptedModelConfigSchema } from "../../src/llm/scripted/scripted-model.ts";
import { NullServerControl } from "../../src/minecraft/server-control/server-control.ts";
import { EventBus, EventPublisher } from "../../src/observability/event-bus.ts";
import type { LabEvent } from "../../src/observability/events.ts";
import { FakeGame } from "../fakes/fake-game.ts";

function setup(script: unknown[]) {
  const game = new FakeGame();
  const bus = new EventBus();
  const events: LabEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const replies: string[] = [];
  const harness = new PrimitiveHarness(HarnessConfigSchema.parse({ harness: "primitive" }), {
    agentName: "Sol",
    owners: ["Owner"],
    privileges: { gameMode: "creative" },
    server: new NullServerControl(),
    game: () => game,
  });
  const model = new ScriptedModel(
    ScriptedModelConfigSchema.parse({
      id: "scripted",
      provider: "scripted",
      model: "scripted",
      pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 },
      script,
    }),
  );
  const session = new AgentSession({
    name: "Sol",
    owners: ["Owner"],
    model,
    harness,
    budget: { maxStepsPerTurn: 10, maxTurnMinutes: 5, maxTurnCostUsd: 1, maxRunCostUsd: 5 },
    privileges: { gameMode: "creative" },
    server: new NullServerControl(),
    events: new EventPublisher(bus, { agent: "Sol", runId: "test-run" }),
    approvals: new ApprovalDesk(() => Promise.resolve()),
    game: () => game,
    runDir: () => ".",
    reply: (text) => {
      replies.push(text);
      return Promise.resolve();
    },
  });
  return { game, events, replies, session };
}

const message = (text: string): OwnerMessage => ({ source: "chat", from: "Owner", text, receivedAtMs: 0 });

describe("AgentSession", () => {
  it("runs tool calls until the model answers, then replies", async () => {
    const { game, events, replies, session } = setup([
      { calls: [{ name: "place_block", arguments: { x: 1, y: 64, z: 1, item: "stone", facing: null, half: null } }] },
      { text: "Placed one stone." },
    ]);
    const outcome = await session.runTurn([message("place a stone")]);

    expect(outcome.status).toBe("completed");
    expect(replies).toEqual(["Placed one stone."]);
    expect(game.world.get({ x: 1, y: 64, z: 1 }).name).toBe("stone");
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "turn.started",
      "model.request",
      "model.response",
      "tool.started",
      "tool.finished",
      "model.request",
      "model.response",
      "turn.ended",
    ]);
    expect(session.totals.toolCalls).toBe(1);
  });

  it("reports invalid arguments to the model instead of crashing", async () => {
    const { events, session } = setup([{ calls: [{ name: "place_block", arguments: { x: "one" } }] }, { text: "ok" }]);
    await session.runTurn([message("go")]);
    const finished = events.find((event) => event.type === "tool.finished");
    expect(finished?.type === "tool.finished" && finished.data.ok).toBe(false);
    expect(finished?.type === "tool.finished" && finished.data.output).toMatch(/Invalid arguments for place_block/);
  });

  it("skips the remaining calls of a response after one fails", async () => {
    const { events, session } = setup([
      {
        calls: [
          { name: "dig_block", arguments: { x: 5, y: 70, z: 5 } },
          { name: "place_block", arguments: { x: 2, y: 64, z: 2, item: "stone", facing: null, half: null } },
        ],
      },
      { text: "ok" },
    ]);
    await session.runTurn([message("go")]);
    const outputs = events.flatMap((event) => (event.type === "tool.finished" ? [event.data.output] : []));
    expect(outputs[0]).toMatch(/^Failed: There is no block to dig/);
    expect(outputs[1]).toMatch(/^Not run: an earlier call/);
  });

  it("ends the turn when the step budget runs out", async () => {
    const loop = Array.from({ length: 20 }, () => ({ calls: [{ name: "wait", arguments: { seconds: 0.1 } }] }));
    const { replies, session } = setup(loop);
    const outcome = await session.runTurn([message("wait forever")]);
    expect(outcome.status).toBe("budget_exceeded");
    expect(replies[0]).toMatch(/steps per turn limit of 10/);
  });

  it("stops promptly on stopTurn", async () => {
    const { session } = setup([{ calls: [{ name: "wait", arguments: { seconds: 30 } }] }, { text: "never" }]);
    const turn = session.runTurn([message("wait")]);
    setTimeout(() => {
      session.stopTurn("test");
    }, 100);
    const outcome = await turn;
    expect(outcome.status).toBe("stopped");
  });

  it("delivers messages that arrive mid-turn as steering", async () => {
    const { events, session } = setup([
      { calls: [{ name: "wait", arguments: { seconds: 0.2 } }] },
      { text: "Adjusted." },
    ]);
    const turn = session.runTurn([message("start")]);
    session.deliver(message("actually, use oak"));
    await turn;
    const delivered = events.find((event) => event.type === "message.delivered");
    expect(delivered?.type === "message.delivered" && delivered.data.message).toBe("actually, use oak");
  });
});
