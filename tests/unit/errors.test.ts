import { describe, expect, it } from "vitest";

import { describeCauses } from "../../src/utils/errors.ts";

describe("describeCauses", () => {
  it("lists nested causes with their codes, outermost first", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
    const error = new Error("Connection error.", { cause: new TypeError("fetch failed", { cause: dns }) });
    expect(describeCauses(error)).toBe(
      "Connection error. <- fetch failed <- getaddrinfo ENOTFOUND api.openai.com [ENOTFOUND]",
    );
  });
});
