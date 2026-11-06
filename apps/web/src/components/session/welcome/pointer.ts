import { createMediaQuery } from "@solid-primitives/media"

/** Touch-first input has no hover and no keyboard, so game copy must not name
 *  click, Space, Escape or R. Scene modules branch on this instead of assuming
 *  a mouse, matching the pointer check already used by file trees. */
export function createCoarsePointer() {
  return createMediaQuery("(hover: none), (pointer: coarse)")
}
