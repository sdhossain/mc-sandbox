/** Text helpers for model-facing output, chat lines and logs. */

/**
 * Shortens `text` to at most `maxChars` characters, keeping the start and the end.
 *
 * The marker in the middle states how much was cut, so the model knows the output is incomplete.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = `\n...[${text.length - maxChars} characters omitted]...\n`;
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** Shortens `text` to at most `maxChars` characters, ending with an ellipsis when cut. */
export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Splits `text` into chunks of at most `maxChars` characters, breaking at whitespace where possible.
 *
 * Used to send long replies as several chat lines; Minecraft rejects chat lines over 256 characters.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars / 2) {
      cut = maxChars;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

/** Formats a number of US dollars for logs and chat, for example `$0.0123`. */
export function formatUsd(amount: number): string {
  return `$${amount < 0.1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/** Formats a byte count, for example `12.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats a duration in milliseconds as seconds or minutes, for example `42.1 s` or `3.5 min`. */
export function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}
