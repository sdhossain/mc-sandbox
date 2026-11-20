import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Reads and edits a `server.properties` file, keeping comments, order and unknown keys.
 *
 * The format is Java properties: `key=value` lines, `#` comments. Values are kept as strings.
 */
export class ServerProperties {
  readonly #lines: string[];

  /** @param text - The file's contents. */
  constructor(text = "") {
    this.#lines = text.split(/\r?\n/);
    if (this.#lines.at(-1) === "") {
      this.#lines.pop();
    }
  }

  /** Reads the file at `path`, or returns an empty set when it does not exist. */
  static read(path: string): ServerProperties {
    return new ServerProperties(existsSync(path) ? readFileSync(path, "utf8") : "");
  }

  /** The value of `key`, or undefined when it is not set. */
  get(key: string): string | undefined {
    const index = this.#indexOf(key);
    if (index === -1) {
      return undefined;
    }
    const line = this.#lines[index] ?? "";
    return unescape(line.slice(line.indexOf("=") + 1));
  }

  /** Sets `key` to `value`, replacing the existing line or appending one. */
  set(key: string, value: string | number | boolean): void {
    const line = `${key}=${escape(String(value))}`;
    const index = this.#indexOf(key);
    if (index === -1) {
      this.#lines.push(line);
    } else {
      this.#lines[index] = line;
    }
  }

  /** The file contents. */
  toString(): string {
    return `${this.#lines.join("\n")}\n`;
  }

  /** Writes the file to `path`. */
  write(path: string): void {
    writeFileSync(path, this.toString());
  }

  #indexOf(key: string): number {
    return this.#lines.findIndex(
      (line) => !line.trimStart().startsWith("#") && line.slice(0, line.indexOf("=")).trim() === key,
    );
  }
}

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/=/g, "\\=");
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}
