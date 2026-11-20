import { runWithLimits } from "../utils/abort.ts";
import { ActionError } from "../utils/errors.ts";

/** The owner's answer to a request. */
export interface ApprovalDecision {
  readonly approved: boolean;
  /** The owner who answered. */
  readonly by: string;
  /** Words after the command, for example the reason in `!deny not now`. */
  readonly note: string;
}

/** Options for {@link ApprovalDesk.ask}. */
export interface AskOptions {
  /** Aborts the wait, for example when the owner says `!stop`. */
  readonly signal?: AbortSignal;
  /** How long to wait for an answer. */
  readonly timeoutMs: number;
}

/**
 * Lets a tool ask the owner for permission and wait for the answer.
 *
 * The question is announced in chat; the owner answers with the `!approve` or `!deny <reason>` control
 * commands, which reach {@link answer} without going through the agent's message queue. One question
 * can be open at a time, which matches the agent loop: tools run one after another.
 */
export class ApprovalDesk {
  readonly #announce: (text: string) => Promise<void>;
  #pending: ((decision: ApprovalDecision) => void) | null = null;

  /** @param announce - Shows a question to the owner, usually by saying it in chat. */
  constructor(announce: (text: string) => Promise<void>) {
    this.#announce = announce;
  }

  /** True while a question waits for an answer. */
  get waiting(): boolean {
    return this.#pending !== null;
  }

  /**
   * Announces `question` and waits for the owner's answer.
   *
   * @throws TimeoutError when no answer arrives within `timeoutMs`.
   * @throws AbortedError when `signal` aborts first.
   * @throws ActionError when another question is still open.
   */
  async ask(question: string, options: AskOptions): Promise<ApprovalDecision> {
    if (this.#pending !== null) {
      throw new ActionError("Another request is still waiting for the owner's answer.");
    }
    const answered = new Promise<ApprovalDecision>((resolve) => {
      this.#pending = resolve;
    });
    try {
      await this.#announce(question);
      return await runWithLimits(() => answered, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        label: "waiting for the owner's answer",
      });
    } finally {
      this.#pending = null;
    }
  }

  /** Answers the open question. Returns false when no question is open. */
  answer(decision: ApprovalDecision): boolean {
    const resolve = this.#pending;
    if (resolve === null) {
      return false;
    }
    this.#pending = null;
    resolve(decision);
    return true;
  }
}
