import type { ServerControl } from "../../minecraft/server-control/server-control.ts";
import { truncateEnd } from "../../utils/text.ts";
import type { EventBus } from "../event-bus.ts";
import type { LabEvent } from "../events.ts";

const MIN_INTERVAL_MS = 600;

/**
 * Shows what an agent is doing above the owners' hotbars (the action bar), through RCON.
 *
 * Unlike chat, the action bar does not scroll or count toward the spam limit, so every tool call can
 * be shown as it happens. Updates are throttled and failures are ignored.
 */
export class InGameNarrator {
  readonly #server: ServerControl;
  readonly #agent: string;
  readonly #owners: () => readonly string[];
  readonly #unsubscribe: () => void;
  #lastShownAt = 0;
  #pending: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param bus - The lab's event bus.
   * @param server - The operator channel used to show the text.
   * @param agent - Only this agent's events are narrated.
   * @param owners - The online owners to show the text to.
   */
  constructor(bus: EventBus, server: ServerControl, agent: string, owners: () => readonly string[]) {
    this.#server = server;
    this.#agent = agent;
    this.#owners = owners;
    this.#unsubscribe = bus.subscribe((event) => {
      if (event.agent === agent) {
        const text = this.#describe(event);
        if (text !== null) {
          this.#show(text);
        }
      }
    });
  }

  /** Stops narrating. */
  close(): void {
    this.#unsubscribe();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
  }

  #describe(event: LabEvent): string | null {
    switch (event.type) {
      case "turn.started":
        return "thinking…";
      case "model.request":
        return `step ${event.step ?? "?"}: thinking…`;
      case "tool.started":
        return `step ${event.step ?? "?"}: ${event.data.name} ${truncateEnd(summariseArguments(event.data.arguments), 60)}`;
      case "tool.progress":
        return `${event.data.name}: ${event.data.message}`;
      case "tool.finished":
        return event.data.ok ? null : `${event.data.name} failed: ${truncateEnd(event.data.output, 60)}`;
      case "turn.ended":
        return `${event.data.status} (${event.data.totals.steps} steps)`;
      default:
        return null;
    }
  }

  #show(text: string): void {
    this.#pending = `[${this.#agent}] ${text}`;
    const wait = this.#lastShownAt + MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.#flush();
    } else {
      this.#timer ??= setTimeout(() => {
        this.#timer = null;
        this.#flush();
      }, wait);
    }
  }

  #flush(): void {
    const text = this.#pending;
    this.#pending = null;
    if (text === null) {
      return;
    }
    this.#lastShownAt = Date.now();
    for (const owner of this.#owners()) {
      this.#server.actionBar(owner, text).catch(() => undefined);
    }
  }
}

function summariseArguments(args: unknown): string {
  if (typeof args !== "object" || args === null) {
    return "";
  }
  return Object.entries(args)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([, value]) => String(value))
    .join(" ");
}
