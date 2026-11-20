import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../../src/agent/agent-config.ts";
import type { ControlCommand } from "../../src/agent/chat-addressing.ts";
import type { OwnerMessage } from "../../src/agent/inbox.ts";
import { askedAQuestion } from "../../src/cases/trial-log.ts";
import { AUTO_REPLY, endedWithQuestion, TrialRunner, type TrialAgent } from "../../src/cases/trial-runner.ts";
import { EventBus, EventPublisher } from "../../src/observability/event-bus.ts";
import { emptyUsage } from "../../src/llm/types.ts";

/** What the stand-in agent's model does in one turn. */
interface ScriptedTurn {
  readonly finalText: string;
  readonly passed: boolean;
  readonly steps: number;
}

/**
 * An agent that plays one scripted turn when `!case` starts it, and the next one for each message it is
 * sent, publishing the same events as a real agent: case.started, then turn.ended and case.result.
 */
class StandInAgent implements TrialAgent {
  readonly name = "Sol";
  readonly config = AgentConfigSchema.parse({ name: "Sol", model: "test-model", harness: "skills" });
  readonly received: OwnerMessage[] = [];
  readonly #events: EventPublisher;
  readonly #turns: ScriptedTurn[];
  #turn = 0;

  constructor(bus: EventBus, turns: readonly ScriptedTurn[]) {
    this.#events = new EventPublisher(bus, { agent: "Sol", runId: "run-1" });
    this.#turns = [...turns];
  }

  control(command: ControlCommand, _from: string, _source: string, argument = ""): Promise<string> {
    if (command !== "case") {
      return Promise.resolve("ok");
    }
    this.#events.emit("case.started", {
      id: argument,
      title: "t",
      category: "t",
      anchor: { x: 1, y: 2, z: 3 },
      prompt: "p",
    });
    // The whole first turn ends before `!case` returns, as it can with a fast model.
    this.#playTurn(argument);
    return Promise.resolve(`Case ${argument} (t): scene built.`);
  }

  submit(message: OwnerMessage): void {
    this.received.push(message);
    setTimeout(() => {
      this.#playTurn("hut");
    }, 5);
  }

  #playTurn(caseId: string): void {
    const turn = this.#turns.shift();
    if (turn === undefined) {
      return;
    }
    this.#turn += 1;
    const totals = {
      turns: 1,
      steps: turn.steps,
      toolCalls: turn.steps - 1,
      toolErrors: 0,
      usage: emptyUsage(),
      costUsd: 0.01 * turn.steps,
    };
    this.#events.emit("turn.ended", {
      status: "completed",
      reason: "end_turn",
      finalText: turn.finalText,
      durationMs: 1000 * turn.steps,
      totals,
    });
    this.#events.emit("case.result", {
      caseId,
      turn: this.#turn,
      passed: turn.passed,
      checks: [{ label: "copy", passed: turn.passed, detail: "" }],
    });
  }
}

async function runTrial(turns: readonly ScriptedTurn[], answerQuestions = true) {
  const bus = new EventBus();
  const agent = new StandInAgent(bus, turns);
  const record = await new TrialRunner(agent, bus, { caseId: "hut", owner: "Owner", answerQuestions }).run(1);
  return { agent, record };
}

const QUESTION = "The pillar stands inside the footprint. May I remove it?";

describe("TrialRunner", () => {
  it("answers once when the model ends its turn with a question, and adds up both turns", async () => {
    const { agent, record } = await runTrial([
      { finalText: QUESTION, passed: false, steps: 3 },
      { finalText: "Built the mirrored hut.", passed: true, steps: 5 },
    ]);
    expect(agent.received).toMatchObject([{ source: "trial", from: "Owner", text: AUTO_REPLY }]);
    expect(record.autoReplies).toEqual([{ turn: 1, question: QUESTION, reply: AUTO_REPLY }]);
    expect(record).toMatchObject({
      runId: "run-1",
      anchor: { x: 1, y: 2, z: 3 },
      passed: true,
      answersQuestions: true,
      status: "completed",
      steps: 8,
      toolCalls: 6,
      durationMs: 8000,
      finalText: "Built the mirrored hut.",
    });
    expect(record.costUsd).toBeCloseTo(0.08);
    expect(askedAQuestion(record)).toBe(true);
  });

  it("answers only once: a second question ends the trial", async () => {
    const { agent, record } = await runTrial([
      { finalText: QUESTION, passed: false, steps: 2 },
      { finalText: "Should I really remove it?", passed: false, steps: 1 },
      { finalText: "unreachable", passed: true, steps: 1 },
    ]);
    expect(agent.received).toHaveLength(1);
    expect(record.autoReplies).toHaveLength(1);
    expect(record).toMatchObject({ passed: false, steps: 3, finalText: "Should I really remove it?" });
  });

  it("does not answer a passed case, a reply without a question, or when answering is off", async () => {
    for (const { turns, answer } of [
      { turns: [{ finalText: "Done. Anything else?", passed: true, steps: 4 }], answer: true },
      { turns: [{ finalText: "I could not find the markers.", passed: false, steps: 4 }], answer: true },
      { turns: [{ finalText: QUESTION, passed: false, steps: 4 }], answer: false },
    ]) {
      const { agent, record } = await runTrial(turns, answer);
      expect(agent.received).toEqual([]);
      expect(record.autoReplies).toEqual([]);
      expect(record.answersQuestions).toBe(answer);
      expect(record.steps).toBe(4);
    }
  });

  it("counts a turn as a question only when the model ended it unfinished and asked something", () => {
    expect(endedWithQuestion("completed", false, QUESTION)).toBe(true);
    expect(endedWithQuestion("completed", true, QUESTION)).toBe(false);
    expect(endedWithQuestion("budget_exceeded", false, QUESTION)).toBe(false);
    expect(endedWithQuestion("completed", false, "Built it.")).toBe(false);
  });
});
