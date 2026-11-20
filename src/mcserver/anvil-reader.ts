import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync, gunzipSync } from "node:zlib";

import nbt from "prismarine-nbt";

import type { BlockPosition, BlockState } from "../minecraft/types.ts";
import { LabError } from "../utils/errors.ts";

/** One 16x16x16 section of a chunk: its palette, and each cell's palette index packed into longs. */
interface Section {
  readonly palette: readonly BlockState[];
  /** Null when the whole section is `palette[0]`. */
  readonly data: readonly bigint[] | null;
}

/** A chunk's sections by their y index (y / 16), or null when the chunk was never saved. */
type Chunk = ReadonlyMap<number, Section> | null;

const AIR: BlockState = { name: "air", properties: {} };
/** Region files hold 32x32 chunks and address them in 4 KiB sectors. */
const SECTOR_BYTES = 4096;
const COMPRESSION_GZIP = 1;
const COMPRESSION_ZLIB = 2;
const COMPRESSION_NONE = 3;

/**
 * Reads blocks straight from a world folder's overworld region files (the Anvil format of Minecraft
 * 1.18 and later), without a server or a bot. Used to read checkpoints, and the live world after the
 * server has written it to disk.
 *
 * Each reader caches the chunks it has read, so make a new reader to see later changes.
 */
export class AnvilReader {
  readonly #worldDir: string;
  readonly #chunks = new Map<string, Chunk>();

  /** @param worldDir - A world folder, the one containing `level.dat` and `region/`. */
  constructor(worldDir: string) {
    if (!existsSync(join(worldDir, "level.dat"))) {
      throw new LabError(`No world at ${worldDir} (level.dat is missing).`);
    }
    this.#worldDir = worldDir;
  }

  /** The block at a position, or null when its chunk was never generated or saved. */
  blockAt(position: BlockPosition): BlockState | null {
    const chunk = this.#chunk(Math.floor(position.x / 16), Math.floor(position.z / 16));
    if (chunk === null) {
      return null;
    }
    const section = chunk.get(Math.floor(position.y / 16));
    if (section === undefined) {
      return AIR;
    }
    if (section.data === null) {
      return section.palette[0] ?? AIR;
    }
    // 1.16+ packing: each long holds floor(64 / bits) indices, and no index spans two longs.
    const bits = Math.max(4, Math.ceil(Math.log2(section.palette.length)));
    const perLong = Math.floor(64 / bits);
    const index = ((position.y & 15) * 16 + (position.z & 15)) * 16 + (position.x & 15);
    const long = section.data[Math.floor(index / perLong)];
    if (long === undefined) {
      throw new LabError(`Corrupt section at ${position.x}, ${position.y}, ${position.z}: too few longs.`);
    }
    const value = Number((long >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
    return section.palette[value] ?? AIR;
  }

  #chunk(chunkX: number, chunkZ: number): Chunk {
    const key = `${chunkX},${chunkZ}`;
    const cached = this.#chunks.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const chunk = this.#readChunk(chunkX, chunkZ);
    this.#chunks.set(key, chunk);
    return chunk;
  }

  #readChunk(chunkX: number, chunkZ: number): Chunk {
    const file = join(this.#worldDir, "region", `r.${Math.floor(chunkX / 32)}.${Math.floor(chunkZ / 32)}.mca`);
    if (!existsSync(file)) {
      return null;
    }
    const region = readFileSync(file);
    const entry = 4 * ((chunkX & 31) + (chunkZ & 31) * 32);
    const sector = ((region[entry] ?? 0) << 16) | ((region[entry + 1] ?? 0) << 8) | (region[entry + 2] ?? 0);
    if (sector === 0) {
      return null;
    }
    const start = sector * SECTOR_BYTES;
    const length = region.readUInt32BE(start);
    const payload = region.subarray(start + 5, start + 4 + length);
    const root = nbt.simplify(nbt.parseUncompressed(decompress(region[start + 4], payload))) as {
      sections?: {
        Y: number;
        block_states?: { palette: { Name: string; Properties?: Record<string, unknown> }[]; data?: unknown[] };
      }[];
    };
    const sections = new Map<number, Section>();
    for (const section of root.sections ?? []) {
      const states = section.block_states;
      if (states === undefined) {
        continue;
      }
      sections.set(section.Y, {
        palette: states.palette.map((entry) => ({
          name: entry.Name.replace(/^minecraft:/, ""),
          properties: Object.fromEntries(
            Object.entries(entry.Properties ?? {}).map(([key, value]) => [key, String(value)]),
          ),
        })),
        data: states.data === undefined ? null : states.data.map(toUnsignedLong),
      });
    }
    return sections;
  }
}

function decompress(type: number | undefined, payload: Buffer): Buffer {
  if (type === COMPRESSION_ZLIB) {
    return inflateSync(payload);
  }
  if (type === COMPRESSION_GZIP) {
    return gunzipSync(payload);
  }
  if (type === COMPRESSION_NONE) {
    return payload;
  }
  throw new LabError(
    `Unsupported chunk compression type ${type ?? "missing"} (chunks stored outside the region file are not supported).`,
  );
}

/** prismarine-nbt gives a long as `[high, low]` 32-bit halves. */
function toUnsignedLong(value: unknown): bigint {
  if (typeof value === "bigint") {
    return BigInt.asUintN(64, value);
  }
  if (Array.isArray(value)) {
    const [high, low] = value as [number, number];
    return BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt(low >>> 0));
  }
  return BigInt.asUintN(64, BigInt(value as number));
}
