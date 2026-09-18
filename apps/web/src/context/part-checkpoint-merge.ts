import type { Part } from "@ericsanchezok/synergy-sdk/client"

/**
 * Merge an authoritative `message.part.updated` checkpoint for a
 * text/reasoning part into the locally accumulated copy.
 *
 * Streaming text is append-only on the wire: deltas only grow `text`, and the
 * server's periodic full-part checkpoints are snapshots of that same growing
 * string. A checkpoint whose text is a strict prefix of the locally
 * accumulated text is therefore an older snapshot (the event-queue's
 * hidden-page delta merge, or the server's part write-buffer flush, can
 * deliver it after deltas the client already applied). Overwriting with it
 * would visibly shrink the rendered segment. Keep the accumulated text and
 * adopt the checkpoint's metadata so non-text leaves still converge.
 *
 * A shorter text that diverges (not a prefix) is a genuine server-side
 * rewrite — apply it verbatim, as are final checkpoints that no longer carry
 * `streaming: true` only insofar as they are longer or diverging: those all
 * fall through to the incoming part unchanged.
 */
export function mergeTextCheckpoint(current: Part, incoming: Part): Part {
  if (incoming.type !== "text" && incoming.type !== "reasoning") return incoming
  const prevText = (current as { text?: unknown }).text
  const nextText = (incoming as { text?: unknown }).text
  if (typeof prevText !== "string" || typeof nextText !== "string") return incoming
  if (nextText.length >= prevText.length) return incoming
  if (!prevText.startsWith(nextText)) return incoming
  return { ...incoming, text: prevText }
}
