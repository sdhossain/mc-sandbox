import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "../utils/errors.ts";

/** The scenes a new case can start from. Each has a commented template in `configs/cases/templates/`. */
export const CaseTemplate = {
  /** Generated: the lab flattens a site around the owner and builds the scene with commands. */
  FLATTEN: "flatten",
  /** Set in the owner's world at a fixed anchor, and put back to a recorded baseline before every run. */
  EXISTING: "existing",
} as const;
export type CaseTemplate = (typeof CaseTemplate)[keyof typeof CaseTemplate];

/** Lower-case words joined by hyphens, as in `mirror-hut`. */
const CASE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The placeholder for the case id in the templates. */
const ID_PLACEHOLDER = "__ID__";

/**
 * Writes `<directory>/<id>.yaml` from a template, ready to edit. The result is a valid case, so it can be
 * listed and run before it is finished.
 *
 * @param directory - The cases directory, which holds the `templates` folder.
 * @returns The path of the new case file.
 * @throws ConfigError when the id is not lower-case words joined by hyphens, or the case already exists.
 */
export function scaffoldCase(directory: string, id: string, template: CaseTemplate): string {
  if (!CASE_ID.test(id)) {
    throw new ConfigError(`A case id is lower-case words joined by hyphens, like "mirror-hut"; got "${id}".`);
  }
  const path = join(directory, `${id}.yaml`);
  if (existsSync(path)) {
    throw new ConfigError(`${path} already exists.`);
  }
  const text = readFileSync(join(directory, "templates", `${template}.yaml`), "utf8").replaceAll(ID_PLACEHOLDER, id);
  writeFileSync(path, text, { flag: "wx" });
  return path;
}
