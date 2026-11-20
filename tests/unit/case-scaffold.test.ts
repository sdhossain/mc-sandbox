import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CaseLibrary } from "../../src/cases/case-library.ts";
import { CaseTemplate, scaffoldCase } from "../../src/cases/case-scaffold.ts";

/** A cases directory holding only the repository's templates. */
function emptyCasesDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mclab-cases-"));
  cpSync("configs/cases/templates", join(directory, "templates"), { recursive: true });
  return directory;
}

describe("case scaffold", () => {
  it("writes a valid case from either template", () => {
    const directory = emptyCasesDirectory();
    scaffoldCase(directory, "copy-stack", CaseTemplate.FLATTEN);
    scaffoldCase(directory, "my-scene", CaseTemplate.EXISTING);
    const cases = CaseLibrary.load(directory);
    expect(cases.get("copy-stack").scene).toBe("flatten");
    expect(cases.get("copy-stack").checks).toHaveLength(2);
    expect(cases.get("my-scene").scene).toBe("existing");
    expect(cases.get("my-scene").reset).toBeDefined();
  });

  it("refuses ids that are not lower-case words joined by hyphens, and cases that exist", () => {
    const directory = emptyCasesDirectory();
    expect(() => scaffoldCase(directory, "Mirror Hut", CaseTemplate.FLATTEN)).toThrow(/lower-case words/);
    expect(() => scaffoldCase(directory, "-hut", CaseTemplate.FLATTEN)).toThrow(/lower-case words/);
    scaffoldCase(directory, "hut", CaseTemplate.FLATTEN);
    expect(() => scaffoldCase(directory, "hut", CaseTemplate.EXISTING)).toThrow(/already exists/);
  });

  it("keeps the templates out of the case list", () => {
    expect(CaseLibrary.load("configs/cases").has("__ID__")).toBe(false);
  });
});
