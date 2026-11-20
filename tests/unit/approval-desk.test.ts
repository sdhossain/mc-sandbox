import { describe, expect, it } from "vitest";

import { ApprovalDesk } from "../../src/agent/approval-desk.ts";
import { AbortedError, TimeoutError } from "../../src/utils/errors.ts";

describe("ApprovalDesk", () => {
  it("announces the question and resolves with the owner's answer", async () => {
    const said: string[] = [];
    const desk = new ApprovalDesk((text) => {
      said.push(text);
      return Promise.resolve();
    });
    const asked = desk.ask("May I have 5 dirt?", { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(said).toEqual(["May I have 5 dirt?"]);
    expect(desk.answer({ approved: false, by: "Owner", note: "not now" })).toBe(true);
    await expect(asked).resolves.toEqual({ approved: false, by: "Owner", note: "not now" });
    expect(desk.waiting).toBe(false);
  });

  it("says when nothing is waiting", () => {
    expect(new ApprovalDesk(() => Promise.resolve()).answer({ approved: true, by: "Owner", note: "" })).toBe(false);
  });

  it("gives up after the time limit and on abort", async () => {
    const desk = new ApprovalDesk(() => Promise.resolve());
    await expect(desk.ask("?", { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    const controller = new AbortController();
    const asked = desk.ask("?", { timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await expect(asked).rejects.toBeInstanceOf(AbortedError);
    expect(desk.waiting).toBe(false);
  });
});
