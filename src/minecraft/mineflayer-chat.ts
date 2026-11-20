import type { Bot } from "mineflayer";

import { sleep } from "../utils/abort.ts";
import { splitIntoChunks } from "../utils/text.ts";
import type { ChatChannel, ChatMessage } from "./game-services.ts";

/** Vanilla rejects longer chat lines. */
const MAX_LINE_CHARS = 250;
/**
 * Vanilla adds 20 to a spam counter per message and removes 1 per tick, kicking above 200, so a
 * sustained rate of one line per second is safe. Commands count too.
 */
const MIN_INTERVAL_MS = 1_100;

/** {@link ChatChannel} for a Mineflayer bot, with a paced send queue. */
export class MineflayerChat implements ChatChannel {
  readonly #bot: Bot;
  readonly #listeners = new Set<(message: ChatMessage) => void>();
  readonly #onChat: (username: string, message: string) => void;
  readonly #onWhisper: (username: string, message: string) => void;
  #queue: Promise<void> = Promise.resolve();
  #lastSentAt = 0;

  /** @param bot - A spawned bot. Call {@link dispose} when it disconnects. */
  constructor(bot: Bot) {
    this.#bot = bot;
    this.#onChat = (username, text) => {
      this.#deliver(username, text, false);
    };
    this.#onWhisper = (username, text) => {
      this.#deliver(username, text, true);
    };
    bot.on("chat", this.#onChat);
    bot.on("whisper", this.#onWhisper);
  }

  /** Says `text` in public chat, split into lines and paced. Resolves when the last line is sent. */
  say(text: string): Promise<void> {
    return this.#enqueue(splitIntoChunks(text, MAX_LINE_CHARS), (line) => {
      this.#bot.chat(line);
    });
  }

  /** Sends a private message, split into lines and paced. */
  whisper(username: string, text: string): Promise<void> {
    return this.#enqueue(splitIntoChunks(text, MAX_LINE_CHARS - username.length - 6), (line) => {
      this.#bot.whisper(username, line);
    });
  }

  /** Registers a listener for chat from other players. */
  onMessage(listener: (message: ChatMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops listening to the bot. */
  dispose(): void {
    this.#bot.removeListener("chat", this.#onChat);
    this.#bot.removeListener("whisper", this.#onWhisper);
    this.#listeners.clear();
  }

  #deliver(username: string, text: string, whisper: boolean): void {
    if (username === this.#bot.username) {
      return;
    }
    const message: ChatMessage = { username, text, whisper, receivedAtMs: Date.now() };
    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  #enqueue(lines: readonly string[], send: (line: string) => void): Promise<void> {
    const next = this.#queue.then(async () => {
      for (const line of lines) {
        const wait = this.#lastSentAt + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) {
          await sleep(wait);
        }
        send(line);
        this.#lastSentAt = Date.now();
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
