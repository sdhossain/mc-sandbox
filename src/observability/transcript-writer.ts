import { createWriteStream, type WriteStream } from "node:fs";

import { formatPosition } from "../minecraft/types.ts";
import { formatDuration, formatUsd, truncateEnd } from "../utils/text.ts";
import type { LabEvent } from "./events.ts";
import type { RunManifest } from "./run-recorder.ts";

const MAX_OUTPUT_CHARS = 1_500;

/**
 * Writes `transcript.md`: the run as a person would want to read it afterwards — each owner message,
 * the model's reasoning summaries and words, every tool call with its result, and per-turn totals.
 */
export class TranscriptWriter {
  readonly #stream: WriteStream;

  /**
   * @param path - Where to write the transcript.
   * @param manifest - The run's setup, written as the header.
   */
  constructor(path: string, manifest: RunManifest) {
    this.#stream = createWriteStream(path, { flags: "a" });
    this.#stream.write(
      `# Run ${manifest.runId}\n\nAgent **${manifest.agent}** · model \`${manifest.model}\` (${manifest.provider}) · harness \`${manifest.harness}\` · privileges \`${JSON.stringify(manifest.privileges)}\` · Minecraft ${manifest.minecraftVersion} · started ${manifest.startedAt}\n`,
    );
  }

  /** Appends the readable form of `event`, if it has one. */
  write(event: LabEvent): void {
    const text = render(event);
    if (text !== null) {
      this.#stream.write(text);
    }
  }

  /** Flushes and closes the file. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#stream.end(() => {
        resolve();
      });
    });
  }
}

function render(event: LabEvent): string | null {
  switch (event.type) {
    case "turn.started":
      return `\n## Turn ${event.turn ?? "?"} — ${event.data.from} (${event.data.source})\n\n${quote(event.data.delivered)}\n`;
    case "model.response": {
      const { usage } = event.data;
      const lines = [
        `\n**Step ${event.step ?? "?"}** · ${formatDuration(event.data.latencyMs)} · ${usage.inputTokens} in (${usage.cachedInputTokens} cached) / ${usage.outputTokens} out (${usage.reasoningTokens} reasoning) · ${formatUsd(event.data.costUsd)}\n`,
      ];
      for (const item of event.data.items) {
        if (item.kind === "reasoning" && item.summary !== "") {
          lines.push(`\n_Reasoning:_ ${item.summary.replace(/\n+/g, " ")}\n`);
        } else if (item.kind === "assistant" && item.text !== "") {
          lines.push(`\n${item.text}\n`);
        }
      }
      return lines.join("");
    }
    case "tool.started":
      return `\n- \`${event.data.name}\` \`${truncateEnd(JSON.stringify(event.data.arguments), 300)}\``;
    case "tool.finished": {
      const code = typeof event.data.data?.code === "string" ? `\n\n\`\`\`js\n${event.data.data.code}\n\`\`\`\n` : "";
      return ` → ${event.data.ok ? "ok" : "**failed**"} (${formatDuration(event.data.durationMs)})${code}\n\n${quote(truncateEnd(event.data.output, MAX_OUTPUT_CHARS))}\n`;
    }
    case "message.delivered":
      return `\n**${event.data.from} (while working):** ${event.data.message}\n`;
    case "model.error":
      return `\n**Model error:** ${event.data.message}\n`;
    case "budget.exceeded":
      return `\n**Budget exceeded:** ${event.data.budget} (${event.data.value} of ${event.data.limit})\n`;
    case "turn.ended": {
      const totals = event.data.totals;
      const reply = event.data.finalText === "" ? "" : `\n\n${quote(event.data.finalText)}`;
      return `\n**Turn ended: ${event.data.status}** (${event.data.reason}) · ${formatDuration(event.data.durationMs)} · ${totals.steps} steps · ${totals.toolCalls} tool calls (${totals.toolErrors} failed) · ${formatUsd(totals.costUsd)}${reply}\n`;
    }
    case "checkpoint.saved":
      return `\n_World checkpoint saved: ${event.data.worldPath}${event.data.gameTime === null ? "" : ` (game tick ${event.data.gameTime})`}_\n`;
    case "case.started":
      return `\n# Case ${event.data.id}: ${event.data.title}\n\nCategory: ${event.data.category} · scene anchored at ${formatPosition(event.data.anchor)}\n`;
    case "case.result": {
      const lines = event.data.checks.map(
        (check) => `- ${check.passed ? "pass" : "FAIL"} · ${check.label}: ${check.detail}`,
      );
      return `\n**Case result after turn ${event.data.turn}: ${event.data.passed ? "PASS" : "FAIL"}**\n\n${lines.join("\n") || "- no automatic checks"}\n`;
    }
    case "bot.lifecycle":
      return event.data.kind === "spawned" || event.data.kind === "connecting"
        ? null
        : `\n_Bot ${event.data.kind}: ${event.data.detail}_\n`;
    default:
      return null;
  }
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
