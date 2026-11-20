import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { readYaml, validate } from "../config/load-config.ts";
import { ConfigError } from "../utils/errors.ts";
import { CaseDefinitionSchema, type CaseDefinition } from "./case-definition.ts";

/** The failure cases in `configs/cases`, validated when loaded. */
export class CaseLibrary {
  readonly #cases: ReadonlyMap<string, CaseDefinition>;
  readonly #directory: string;

  /**
   * @param cases - Validated cases. Use {@link load} to read them from a directory.
   * @param directory - Where the case files and their baselines are.
   */
  constructor(cases: readonly CaseDefinition[], directory = "configs/cases") {
    this.#cases = new Map(cases.map((definition) => [definition.id, definition]));
    this.#directory = directory;
  }

  /**
   * Reads and validates every `.yaml` file in `directory`. A missing directory gives an empty library.
   *
   * @throws ConfigError when a file is invalid or its `id` does not match its file name.
   */
  static load(directory: string): CaseLibrary {
    if (!existsSync(directory)) {
      return new CaseLibrary([]);
    }
    const cases = readdirSync(directory)
      .filter((file) => file.endsWith(".yaml"))
      .sort()
      .map((file) => {
        const path = join(directory, file);
        const definition = validate(CaseDefinitionSchema, readYaml(path), path);
        if (definition.id !== basename(file, ".yaml")) {
          throw new ConfigError(`${path}: id "${definition.id}" must match the file name.`);
        }
        return definition;
      });
    return new CaseLibrary(cases, directory);
  }

  /** The baseline file of a case with a `reset` box. */
  baselinePath(id: string): string {
    return join(this.#directory, `${id}.baseline.json.gz`);
  }

  /** True when there is a case with this id. */
  has(id: string): boolean {
    return this.#cases.has(id);
  }

  /** Every case, in file-name order. */
  list(): CaseDefinition[] {
    return [...this.#cases.values()];
  }

  /**
   * The case with this id.
   *
   * @throws ConfigError listing the known ids when there is none.
   */
  get(id: string): CaseDefinition {
    const definition = this.#cases.get(id);
    if (definition === undefined) {
      throw new ConfigError(`Unknown case "${id}". Known: ${[...this.#cases.keys()].join(", ") || "(none)"}.`);
    }
    return definition;
  }
}
