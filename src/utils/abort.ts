import { AbortedError, TimeoutError } from "./errors.ts";

/**
 * Throws {@link AbortedError} if `signal` has already been aborted.
 *
 * Long-running code calls this between steps so that `!stop` takes effect promptly.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AbortedError(abortReason(signal));
  }
}

/** Resolves after `ms` milliseconds, or rejects with {@link AbortedError} as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AbortedError(abortReason(signal)));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError(abortReason(signal)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Options for {@link runWithLimits}. */
export interface LimitOptions {
  /** Time limit in milliseconds. Omit for no limit. */
  readonly timeoutMs?: number;
  /** Aborts the operation early. */
  readonly signal?: AbortSignal;
  /**
   * Called once when the time limit or the abort signal ends the operation early, to stop the underlying
   * work. Not called when the operation fails by itself: it has already stopped.
   */
  readonly onCancel?: () => void;
  /** Names the operation in the timeout message. */
  readonly label?: string;
}

/**
 * Runs `operation` with a time limit and an abort signal, even when the operation itself ignores both.
 *
 * Mineflayer calls such as `pathfinder.goto` or `bot.dig` take no `AbortSignal`, so the promise is raced
 * against the timeout and the signal, and `onCancel` stops the bot when the limits win the race.
 *
 * @param operation - Receives a signal that aborts on timeout or on the caller's abort.
 * @throws TimeoutError when the time limit passes first.
 * @throws AbortedError when the caller's signal aborts first.
 */
export async function runWithLimits<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: LimitOptions = {},
): Promise<T> {
  const { timeoutMs, signal, onCancel, label = "operation" } = options;
  throwIfAborted(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  // An object, because the closures below assign it and TypeScript does not track closure assignments.
  const outcome = { cutShort: false };
  const limits = new Promise<never>((_, reject) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        outcome.cutShort = true;
        reject(new TimeoutError(`${label} timed out after ${Math.round(timeoutMs / 1000)} s`, timeoutMs));
      }, timeoutMs);
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        outcome.cutShort = true;
        reject(new AbortedError(abortReason(signal)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }
  });

  try {
    return await Promise.race([operation(controller.signal), limits]);
  } catch (error) {
    controller.abort(error);
    if (outcome.cutShort) {
      onCancel?.();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}

/** Returns the abort reason as a message. */
export function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  return typeof reason === "string" ? reason : "Aborted";
}
