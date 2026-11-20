import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import type { HarnessConfig } from "../harness/harness.ts";
import { HARNESS_REGISTRY } from "../harness/registry.ts";
import type { ModelConfig } from "../llm/language-model.ts";
import { PROVIDER_REGISTRY } from "../llm/registry.ts";
import { ConfigError } from "../utils/errors.ts";
import { isNameOf, HarnessName, ProviderName } from "../utils/names.ts";
import { LabConfigSchema, OWNERS_VARIABLE, type LabConfig } from "./lab-config.ts";

/** Where the config files live, relative to the repository root. */
export const ConfigPaths = {
  LAB: "configs/lab.yaml",
  MODELS: "configs/models.yaml",
  HARNESSES: "configs/harnesses",
  CASES: "configs/cases",
} as const;

/** Reads a YAML file. @throws ConfigError when it is missing or not valid YAML. */
export function readYaml(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  try {
    return parseYaml(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(`${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validates `data` with `schema`. @throws ConfigError listing every problem with its path. */
export function validate<S extends z.ZodType>(schema: S, data: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(top level)"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid config in ${source}:\n${problems.join("\n")}`);
  }
  return result.data;
}

/**
 * Loads and validates `configs/lab.yaml` (or another lab file). When `MCLAB_OWNERS` is set, its names replace the
 * file's `owners`.
 */
export function loadLabConfig(path: string = ConfigPaths.LAB, env: NodeJS.ProcessEnv = process.env): LabConfig {
  const data = readYaml(path);
  const owners = (env[OWNERS_VARIABLE] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (owners.length === 0 || typeof data !== "object" || data === null) {
    return validate(LabConfigSchema, data, path);
  }
  return validate(LabConfigSchema, { ...data, owners }, `${path} (owners from ${OWNERS_VARIABLE})`);
}

/** Loads every model preset from `configs/models.yaml`, validated by its provider's schema, keyed by id. */
export function loadModelCatalog(path: string = ConfigPaths.MODELS): Map<string, ModelConfig> {
  const data = readYaml(path) as { models?: unknown };
  if (!Array.isArray(data.models)) {
    throw new ConfigError(`${path} must have a top-level "models" list.`);
  }
  const catalog = new Map<string, ModelConfig>();
  data.models.forEach((entry: unknown, index) => {
    const provider = (entry as { provider?: unknown }).provider;
    if (typeof provider !== "string" || !isNameOf(ProviderName, provider)) {
      throw new ConfigError(
        `${path}: models[${index}].provider must be one of ${Object.values(ProviderName).join(", ")}.`,
      );
    }
    const config = validate(PROVIDER_REGISTRY.get(provider).configSchema, entry, `${path} models[${index}]`);
    if (catalog.has(config.id)) {
      throw new ConfigError(`${path}: model id "${config.id}" appears twice.`);
    }
    catalog.set(config.id, config);
  });
  return catalog;
}

/** Loads the harness preset `configs/harnesses/<name>.yaml`, validated by its harness's schema. */
export function loadHarnessPreset(name: string, directory: string = ConfigPaths.HARNESSES): HarnessConfig {
  const path = join(directory, `${name}.yaml`);
  if (!existsSync(path)) {
    throw new ConfigError(`Unknown harness preset "${name}". Available: ${listHarnessPresets(directory).join(", ")}.`);
  }
  const data = readYaml(path) as { harness?: unknown };
  if (typeof data.harness !== "string" || !isNameOf(HarnessName, data.harness)) {
    throw new ConfigError(`${path}: "harness" must be one of ${Object.values(HarnessName).join(", ")}.`);
  }
  return validate(HARNESS_REGISTRY.get(data.harness).configSchema, data, path);
}

/** Names of the harness presets in `directory`. */
export function listHarnessPresets(directory: string = ConfigPaths.HARNESSES): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => basename(file, ".yaml"))
    .sort();
}
