import type { MessageSource } from "../utils/names.ts";

/** A task or steering message from an owner. */
export interface OwnerMessage {
  readonly source: MessageSource;
  readonly from: string;
  readonly text: string;
  readonly receivedAtMs: number;
}

/**
 * The queue of owner messages for one agent.
 *
 * When the agent is idle, the next message starts a turn. When it is busy, messages wait here and the
 * agent drains them between steps, so the owner can steer a task in progress.
 */
export class Inbox {
  readonly #messages: OwnerMessage[] = [];
  #waiter: (() => void) | null = null;

  /** Adds a message and wakes the agent if it is waiting. */
  push(message: OwnerMessage): void {
    this.#messages.push(message);
    const wake = this.#waiter;
    this.#waiter = null;
    wake?.();
  }

  /** Number of waiting messages. */
  get size(): number {
    return this.#messages.length;
  }

  /** Takes every waiting message. */
  drain(): OwnerMessage[] {
    return this.#messages.splice(0, this.#messages.length);
  }

  /** Waits until at least one message is queued, then takes them all. Resolves to [] if `signal` aborts. */
  async takeAll(signal: AbortSignal): Promise<OwnerMessage[]> {
    while (this.#messages.length === 0) {
      if (signal.aborted) {
        return [];
      }
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
    return this.drain();
  }
}
