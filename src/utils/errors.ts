/**
 * Error types shared across the lab.
 *
 * Every error the lab raises on purpose extends {@link LabError}, so callers can tell expected failures
 * (bad config, unknown name, game action failed) from bugs.
 */

/** Base class for errors the lab raises on purpose. */
export class LabError extends Error {
  /**
   * @param message - Human-readable description, written so it can be shown to the owner or the model.
   * @param options - Standard error options, such as the underlying `cause`.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A configuration file or CLI flag is invalid. */
export class ConfigError extends LabError {}

/** A registry lookup used a name that was never registered. */
export class UnknownNameError extends LabError {}

/** Two components were registered under the same name. */
export class DuplicateNameError extends LabError {}

/** An operation was aborted, by the owner (`!stop`) or by shutdown. */
export class AbortedError extends LabError {
  constructor(message = "Aborted", options?: ErrorOptions) {
    super(message, options);
  }
}

/** An operation ran past its time limit. */
export class TimeoutError extends LabError {
  /** The time limit that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: ErrorOptions) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A game action could not be carried out, for an expected reason (no path, out of reach, missing item).
 *
 * Tools turn this into an error result for the model rather than a crash, so the message must say what
 * went wrong in terms the model can act on.
 */
export class ActionError extends LabError {}

/** The model provider returned an error or an unusable response. */
export class ModelError extends LabError {
  /** True when retrying the same request may succeed (rate limits, timeouts, 5xx). */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.retryable = retryable;
  }
}

/** Returns a one-line message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * The messages and error codes of an error and its causes, outermost first, for example
 * `Connection error. <- fetch failed <- getaddrinfo ENOTFOUND api.openai.com [ENOTFOUND]`.
 */
export function describeCauses(error: unknown, maxDepth = 6): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    const { message, code, cause } = current as { message?: unknown; code?: unknown; cause?: unknown };
    const text = typeof message === "string" && message !== "" ? message : JSON.stringify(current);
    parts.push(typeof code === "string" ? `${text} [${code}]` : text);
    current = cause;
  }
  return parts.join(" <- ");
}

/** Returns true when `error` signals an abort, from the lab or from the platform (`AbortSignal`). */
export function isAbortError(error: unknown): boolean {
  return error instanceof AbortedError || (error instanceof Error && error.name === "AbortError");
}
