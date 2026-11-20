import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minecraft 1.21.11 needs Java 21 or newer. */
export const REQUIRED_JAVA_MAJOR = 21;

/** A Java runtime that was found, with its major version. */
export interface JavaRuntime {
  readonly path: string;
  readonly major: number;
  readonly source: string;
}

/**
 * Finds a Java runtime that can run the server: `JAVA_HOME`, then `java` on the PATH, then the runtime
 * the Minecraft Launcher downloads for the game itself (so players need not install Java separately).
 */
export class JavaLocator {
  /** Every Java runtime found, best candidates first. */
  candidates(): JavaRuntime[] {
    const found: JavaRuntime[] = [];
    const javaHome = process.env.JAVA_HOME;
    const sources: [string, string][] = [
      ...(javaHome === undefined ? [] : [[join(javaHome, "bin", javaExecutable()), "JAVA_HOME"] as [string, string]]),
      ["java", "PATH"],
      ...launcherRuntimes().map((path): [string, string] => [path, "Minecraft Launcher runtime"]),
    ];
    for (const [path, source] of sources) {
      const major = javaMajorVersion(path);
      if (major !== null) {
        found.push({ path, major, source });
      }
    }
    return found;
  }

  /** The first runtime with Java 21 or newer, or null. */
  find(): JavaRuntime | null {
    return this.candidates().find((runtime) => runtime.major >= REQUIRED_JAVA_MAJOR) ?? null;
  }
}

/** The major version reported by `<path> -version`, or null when it does not run. */
export function javaMajorVersion(path: string): number | null {
  // `java -version` prints to stderr.
  const result = spawnSync(path, ["-version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return parseJavaVersion(`${result.stderr}${result.stdout}`);
}

/** Parses `version "21.0.7"` or `version "1.8.0_402"` from `java -version` output. */
export function parseJavaVersion(output: string): number | null {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (match === null) {
    return null;
  }
  const first = Number(match[1]);
  return first === 1 ? Number(match[2] ?? 0) : first;
}

/** Java executables inside the Minecraft Launcher's runtime folders, newest component first. */
function launcherRuntimes(): string[] {
  const roots = [
    join(homedir(), "Library", "Application Support", "minecraft", "runtime"),
    join(homedir(), ".minecraft", "runtime"),
    ...(process.env.APPDATA === undefined ? [] : [join(process.env.APPDATA, ".minecraft", "runtime")]),
    ...(process.env.LOCALAPPDATA === undefined
      ? []
      : [
          join(
            process.env.LOCALAPPDATA,
            "Packages",
            "Microsoft.4297127D64EC6_8wekyb3d8bbwe",
            "LocalCache",
            "Local",
            "runtime",
          ),
        ]),
  ];
  const paths: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const component of readdirSync(root).sort().reverse()) {
      const componentDir = join(root, component);
      for (const platform of safeList(componentDir)) {
        const home = join(componentDir, platform, component);
        paths.push(join(home, "jre.bundle", "Contents", "Home", "bin", "java"), join(home, "bin", javaExecutable()));
      }
    }
  }
  return paths.filter((path) => existsSync(path));
}

function safeList(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function javaExecutable(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}
