import { summariseResult } from "../../cases/case-checks.ts";
import { formatBytes, formatDuration, formatUsd, truncateEnd } from "../../utils/text.ts";
import type { EventBus } from "../event-bus.ts";
import type { LabEvent } from "../events.ts";

/** Prints a compact, live line per interesting event to the terminal. */
export class ConsoleSink {
  readonly #unsubscribe: () => void;
  readonly #verbose: boolean;

  /**
   * @param bus - The lab's event bus.
   * @param verbose - Also print model text and full tool output.
   */
  constructor(bus: EventBus, verbose = false) {
    this.#verbose = verbose;
    this.#unsubscribe = bus.subscribe((event) => {
      const line = this.#format(event);
      if (line !== null) {
        console.log(line);
      }
    });
  }

  /** Stops printing. */
  close(): void {
    this.#unsubscribe();
  }

  #format(event: LabEvent): string | null {
    const where = `[${event.agent}${event.turn === undefined ? "" : ` t${event.turn}`}${event.step === undefined ? "" : `.${event.step}`}]`;
    switch (event.type) {
      case "run.started":
        return `${where} run started: ${event.data.model} on the ${event.data.harness} harness with ${event.data.tools.length} tools`;
      case "turn.started":
        return `${where} ${event.data.from}: ${event.data.message}`;
      case "model.response": {
        const text = event.data.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text)
          .join(" ");
        const said = this.#verbose && text !== "" ? ` "${truncateEnd(text, 200)}"` : "";
        return `${where} model ${formatDuration(event.data.latencyMs)} ${formatUsd(event.data.costUsd)}${said}`;
      }
      case "tool.finished":
        return `${where} ${event.data.ok ? "ok  " : "FAIL"} ${event.data.name}: ${truncateEnd(event.data.output.replace(/\s+/g, " "), this.#verbose ? 400 : 140)}`;
      case "turn.ended":
        return `${where} turn ${event.data.status} in ${formatDuration(event.data.durationMs)}, ${event.data.totals.steps} steps, ${formatUsd(event.data.totals.costUsd)}${event.data.finalText === "" ? "" : `: ${truncateEnd(event.data.finalText, 200)}`}`;
      case "message.queued":
        return `${where} queued from ${event.data.from}: ${event.data.message}`;
      case "control.command":
        return `${where} !${event.data.command} from ${event.data.from}`;
      case "model.error":
        return `${where} MODEL ERROR: ${event.data.message}`;
      case "budget.exceeded":
        return `${where} budget exceeded: ${event.data.budget}`;
      case "bot.lifecycle":
        return `${where} bot ${event.data.kind}: ${event.data.detail}`;
      case "checkpoint.saved":
        return `${where} checkpoint ${event.data.id} saved (${formatBytes(event.data.copiedBytes)} new, ${formatDuration(event.data.durationMs)})`;
      case "case.started":
        return `${where} CASE ${event.data.id} (${event.data.category}): ${event.data.title}`;
      case "case.result":
        return `${where} ${summariseResult(event.data)}`;
      case "log":
        return event.data.level === "debug" && !this.#verbose
          ? null
          : `${where} ${event.data.level}: ${event.data.message}`;
      default:
        return null;
    }
  }
}
