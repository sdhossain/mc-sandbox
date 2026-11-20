import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import type { Totals } from "./events.ts";
import type { EventBus } from "./event-bus.ts";
import type { LabEvent } from "./events.ts";
import { TranscriptWriter } from "./transcript-writer.ts";
import { RunStatus } from "../utils/names.ts";

/** What `run.json` records about a run when it starts. */
export interface RunManifest {
  readonly runId: string;
  readonly agent: string;
  readonly harness: string;
  readonly model: string;
  readonly provider: string;
  readonly privileges: unknown;
  readonly minecraftVersion: string;
  readonly owners: readonly string[];
  readonly startedAt: string;
}

/** File names inside a run directory. */
export const RunFiles = {
  MANIFEST: "run.json",
  EVENTS: "events.jsonl",
  TRANSCRIPT: "transcript.md",
  BLOCK_CHANGES: "block-changes.jsonl",
  CODE_DIR: "code",
  SNAPSHOT_DIR: "snapshots",
  /** The failure case the run is for: its definition, anchor, prompt and setup commands. */
  CASE: "case.json",
} as const;

/**
 * Writes one run's directory: every event to `events.jsonl`, a readable `transcript.md`, block
 * changes to `block-changes.jsonl`, executed code to `code/`, and the manifest `run.json`, which is
 * rewritten with the final status and totals when the run ends.
 */
export class RunRecorder {
  readonly runDir: string;
  readonly #manifest: RunManifest;
  readonly #events: WriteStream;
  readonly #changes: WriteStream;
  readonly #transcript: TranscriptWriter;
  readonly #unsubscribe: () => void;

  /**
   * Creates the directory and starts recording the events of `manifest.agent`'s run `manifest.runId`.
   *
   * @param bus - The lab's event bus.
   * @param runDir - The directory to create for this run.
   * @param manifest - The run's setup, written to `run.json`.
   */
  constructor(bus: EventBus, runDir: string, manifest: RunManifest) {
    this.runDir = runDir;
    this.#manifest = manifest;
    mkdirSync(join(runDir, RunFiles.CODE_DIR), { recursive: true });
    mkdirSync(join(runDir, RunFiles.SNAPSHOT_DIR), { recursive: true });
    this.#writeManifest({ status: RunStatus.RUNNING });
    this.#events = createWriteStream(join(runDir, RunFiles.EVENTS), { flags: "a" });
    this.#changes = createWriteStream(join(runDir, RunFiles.BLOCK_CHANGES), { flags: "a" });
    this.#transcript = new TranscriptWriter(join(runDir, RunFiles.TRANSCRIPT), manifest);
    this.#unsubscribe = bus.subscribe((event) => {
      if (event.agent === manifest.agent && event.runId === manifest.runId) {
        this.#record(event);
      }
    });
  }

  /** Writes a JSON file inside the run directory and returns its path relative to it. */
  writeJson(relativePath: string, value: unknown): string {
    writeFileSync(join(this.runDir, relativePath), `${JSON.stringify(value, null, 1)}\n`);
    return relativePath;
  }

  /** Stops recording, and rewrites `run.json` with the final status and totals. */
  async finish(status: RunStatus, totals: Totals): Promise<void> {
    this.#unsubscribe();
    this.#writeManifest({ status, endedAt: new Date().toISOString(), totals });
    await Promise.all([closeStream(this.#events), closeStream(this.#changes), this.#transcript.close()]);
  }

  #record(event: LabEvent): void {
    this.#events.write(`${JSON.stringify(event)}\n`);
    this.#transcript.write(event);
    if (event.type === "world.changes") {
      for (const change of event.data.changes) {
        this.#changes.write(`${JSON.stringify({ ...change, turn: event.turn, step: event.step })}\n`);
      }
    }
    if (event.type === "tool.finished" && typeof event.data.data?.code === "string") {
      const name = `turn${String(event.turn ?? 0).padStart(3, "0")}-step${String(event.step ?? 0).padStart(3, "0")}-${event.data.callId}.js`;
      writeFileSync(join(this.runDir, RunFiles.CODE_DIR, name.replace(/[^\w.-]/g, "_")), event.data.data.code);
    }
  }

  #writeManifest(extra: Record<string, unknown>): void {
    writeFileSync(
      join(this.runDir, RunFiles.MANIFEST),
      `${JSON.stringify({ ...this.#manifest, ...extra }, null, 2)}\n`,
    );
  }
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => {
      resolve();
    });
  });
}

/** A run id such as `20261119-081530_Sol_primitive_gpt-6.2-sol`: sortable by time, readable, safe as a directory name. */
export function makeRunId(now: Date, agent: string, harness: string, model: string): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return [stamp, agent, harness, model].map((part) => part.replace(/[^\w.-]/g, "_")).join("_");
}
