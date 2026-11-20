/**
 * Type declarations for Mineflayer internals the lab relies on that its own `index.d.ts` leaves out.
 * Each entry names the Mineflayer 4.39 source file that defines it.
 */

import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";

declare module "mineflayer" {
  /** Options of `_genericPlace` (lib/plugins/generic_place.js). */
  interface PlaceBlockOptions {
    /** For side faces: click the top or bottom half, which decides stair and slab halves. */
    half?: "top" | "bottom" | undefined;
    /** Cursor position on the face, overriding the face centre. */
    delta?: Vec3;
    /** `true` snaps the look to the face; `"ignore"` keeps the current look, which decides a block's facing. */
    forceLook?: boolean | "ignore";
    offhand?: boolean;
    swingArm?: "right" | "left";
    showHand?: boolean;
  }

  interface Bot {
    /**
     * `placeBlock` with options; resolves when the server's block update arrives, rejects after 5 s
     * without one or when the server refuses (lib/plugins/place_block.js).
     */
    _placeBlockWithOptions(referenceBlock: Block, faceVector: Vec3, options: PlaceBlockOptions): Promise<void>;
  }
}
