// Merge helpers for Scope bootstrap snapshots that arrive behind events the
// store already applied. The server stamps the response sequence before
// reading snapshot data, so a same-epoch response whose seq is behind the
// Scope's applied event watermark predates those events. Events are
// authoritative for the buckets they write, so such a snapshot must fill gaps
// without overwriting newer live state — a plain reconcile would delete every
// key the events added (e.g. a busy session status driving the sidebar
// running icon).

export function mergeSessionStatusSnapshot<S>(
  snapshot: Record<string, S>,
  local: Record<string, S>,
): Record<string, S> {
  return { ...snapshot, ...local }
}

export function mergeIdKeyedSnapshot<T extends { id: string }>(snapshot: readonly T[], local: readonly T[]): T[] {
  if (local.length === 0) return snapshot.slice()
  const localIDs = new Set(local.map((item) => item.id))
  return [...local, ...snapshot.filter((item) => !localIDs.has(item.id))]
}
