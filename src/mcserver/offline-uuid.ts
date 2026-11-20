import { createHash } from "node:crypto";

/**
 * The UUID an offline-mode server gives a player name: a version 3 UUID of the bytes of
 * `OfflinePlayer:<name>`, as Java's `UUID.nameUUIDFromBytes` computes it.
 *
 * Player data files (`playerdata/<uuid>.dat`) and `ops.json` are keyed by this UUID.
 */
export function offlineUuid(name: string): string {
  const hash = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x30;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
