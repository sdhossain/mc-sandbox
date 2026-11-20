import { DuplicateNameError, UnknownNameError } from "./errors.ts";

/**
 * A name-to-component map that components add themselves to when their module is imported.
 *
 * This is the TypeScript form of the decorator registries in TamperBench: a component module ends with
 * `HARNESS_REGISTRY.register(...)`, and the package's `index.ts` imports every component module so that
 * all registrations run before the registry is read.
 *
 * @typeParam K - The name type, usually a union from `names.ts`.
 * @typeParam V - The registered entry, usually a class plus its config schema.
 */
export class Registry<K extends string, V> {
  /** What the registry holds, for error messages, for example "harness". */
  readonly kind: string;
  readonly #entries = new Map<K, V>();

  /** @param kind - What the registry holds, used in error messages. */
  constructor(kind: string) {
    this.kind = kind;
  }

  /**
   * Adds an entry.
   *
   * @throws DuplicateNameError if `name` is already registered.
   */
  register(name: K, entry: V): void {
    if (this.#entries.has(name)) {
      throw new DuplicateNameError(`A ${this.kind} named "${name}" is already registered.`);
    }
    this.#entries.set(name, entry);
  }

  /**
   * Returns the entry registered under `name`.
   *
   * @throws UnknownNameError if nothing is registered under `name`; the message lists the known names.
   */
  get(name: K): V {
    const entry = this.#entries.get(name);
    if (entry === undefined) {
      const known = [...this.#entries.keys()].join(", ") || "(none)";
      throw new UnknownNameError(`Unknown ${this.kind} "${name}". Known: ${known}.`);
    }
    return entry;
  }

  /** Returns true when an entry is registered under `name`. */
  has(name: K): boolean {
    return this.#entries.has(name);
  }

  /** Returns the registered names in registration order. */
  names(): K[] {
    return [...this.#entries.keys()];
  }
}
