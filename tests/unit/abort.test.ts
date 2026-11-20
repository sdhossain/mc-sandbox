import { describe, expect, it } from "vitest";

import { runWithLimits } from "../../src/utils/abort.ts";
import { AbortedError, TimeoutError } from "../../src/utils/errors.ts";

describe("runWithLimits", () => {
  it("does not cancel an operation that failed by itself", async () => {
    let cancelled = 0;
    await expect(
      runWithLimits(() => Promise.reject(new Error("no path")), {
        timeoutMs: 1_000,
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ).rejects.toThrow("no path");
    expect(cancelled).toBe(0);
  });

  it("cancels the operation when the time limit passes", async () => {
    let cancelled = 0;
    await expect(
      runWithLimits(() => new Promise(() => undefined), {
        timeoutMs: 20,
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(cancelled).toBe(1);
  });

  it("cancels the operation when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const run = runWithLimits(() => new Promise(() => undefined), {
      signal: controller.signal,
      onCancel: () => {
        cancelled += 1;
      },
    });
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(AbortedError);
    expect(cancelled).toBe(1);
  });
});
