import { describe, expect, it } from "vitest";

import { ChatAddressing } from "../../src/agent/chat-addressing.ts";

describe("ChatAddressing", () => {
  const solo = new ChatAddressing("Sol", ["Owner"], () => ["Sol"]);
  const pair = new ChatAddressing("Sol", ["Owner"], () => ["Sol", "Luna"]);

  it("treats unaddressed lines as tasks when the agent is alone", () => {
    expect(solo.interpret("Owner", "build a farm", false)).toEqual({ kind: "task", text: "build a farm" });
  });

  it("ignores players who are not owners", () => {
    expect(solo.interpret("Stranger", "build a farm", false)).toEqual({ kind: "ignored" });
  });

  it("routes by name prefix when several agents are online", () => {
    expect(pair.interpret("Owner", "Sol, build a farm", false)).toEqual({ kind: "task", text: "build a farm" });
    expect(pair.interpret("Owner", "@sol build a farm", false)).toEqual({ kind: "task", text: "build a farm" });
    expect(pair.interpret("Owner", "Luna build a farm", false)).toEqual({ kind: "ignored" });
    expect(pair.interpret("Owner", "build a farm", false)).toEqual({ kind: "ignored" });
    expect(pair.interpret("Owner", "@all !stop", false)).toEqual({ kind: "control", command: "stop", argument: "" });
  });

  it("treats whispers as addressed", () => {
    expect(pair.interpret("Owner", "!status", true)).toEqual({ kind: "control", command: "status", argument: "" });
  });

  it("passes unknown bang words through as tasks", () => {
    expect(solo.interpret("Owner", "!dance now", false)).toEqual({ kind: "task", text: "!dance now" });
  });
});
