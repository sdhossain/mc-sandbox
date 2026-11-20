import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { CodeSyntaxError, prepareCode } from "../../src/harness/code/loop-guard.ts";

describe("prepareCode", () => {
  it("guards every kind of loop, including bodies without braces", () => {
    const { source } = prepareCode(
      "for (;;) x++;\nwhile (a) { b(); }\ndo c(); while (d);\nfor (const e of f) for (const g in e) h();",
    );
    expect(source.match(/__guard\(\);/g)?.length).toBe(5);
  });

  it("lets a guard stop an infinite synchronous loop", async () => {
    let calls = 0;
    const { source } = prepareCode("while (true) { }");
    const run = runInNewContext(source, {
      __guard: () => {
        calls += 1;
        if (calls > 1000) {
          throw new Error("cancelled");
        }
      },
    }) as () => Promise<unknown>;
    await expect(run()).rejects.toThrow("cancelled");
  });

  it("keeps await and return working in the wrapped body", async () => {
    const { source } = prepareCode("const v = await Promise.resolve(2);\nreturn v * 3;");
    const run = runInNewContext(source, { __guard: () => undefined }) as () => Promise<unknown>;
    await expect(run()).resolves.toBe(6);
  });

  it("reports syntax errors with the model's line numbers", () => {
    expect(() => prepareCode("const a = 1;\nconst = 2;")).toThrow(CodeSyntaxError);
    try {
      prepareCode("const a = 1;\nconst = 2;");
    } catch (error) {
      expect((error as CodeSyntaxError).line).toBe(2);
    }
  });
});
