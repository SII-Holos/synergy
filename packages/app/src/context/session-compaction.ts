// Pure planning for the post-compaction message swap (issue #319 / blank-frame
// flash). The old handler deleted every message/part for the session and only
// then refetched, so the timeline rendered empty until the network round-trip
// returned. Instead we fetch first, compute the replacement plan here, and apply
// it atomically — the timeline keeps its old content until the swap.

type MessageLike = { id: string }
type PartLike = { id?: string }
type FetchedItem<M extends MessageLike, P extends PartLike> = { info: M; parts: readonly P[] }

/**
 * Given the message ids currently in the store and the freshly fetched
 * post-compaction items, compute:
 *   - keep:  the messages to display, id-sorted and capped to `cap` (newest kept)
 *   - parts: id-sorted parts for each kept message
 *   - dropPartMessageIds: currently-stored message ids that are gone after
 *     compaction, whose part buckets must be released
 */
export function planCompactionReplace<M extends MessageLike, P extends PartLike>(
  currentMessageIds: readonly string[],
  fetched: readonly FetchedItem<M, P>[],
  cap = 500,
): { keep: M[]; parts: Record<string, P[]>; dropPartMessageIds: string[] } {
  const items = fetched.filter((x) => !!x?.info?.id)
  const all = items
    .map((x) => x.info)
    .filter((m) => !!m?.id)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
  const keep = all.length > cap ? all.slice(-cap) : all
  const keepIds = new Set(keep.map((m) => m.id))

  const parts: Record<string, P[]> = {}
  for (const item of items) {
    if (!keepIds.has(item.info.id)) continue
    parts[item.info.id] = item.parts
      .filter((p) => !!p?.id)
      .slice()
      .sort((a, b) => a.id!.localeCompare(b.id!))
  }

  const dropPartMessageIds = currentMessageIds.filter((id) => !keepIds.has(id))
  return { keep, parts, dropPartMessageIds }
}
