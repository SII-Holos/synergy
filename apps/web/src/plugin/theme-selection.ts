export interface RecordedThemeSelection {
  id: string
  /** Whether the selection's persistence PATCH completed server-side. */
  persisted: boolean
}

let selection: { serverUrl: string; id: string; persisted: boolean } | undefined

/**
 * Records a theme selection made in this UI for the current page's lifetime,
 * scoped to the server it was made against. Module state on purpose: the
 * plugin bridge remounts on session transitions and server changes, and the
 * record must survive those remounts so a config fetch racing the selection's
 * fire-and-forget persistence cannot replay the stale value. Keying by server
 * URL keeps one server's selection from suppressing another server's
 * persisted preference across a `ServerKey` remount.
 */
export function recordThemeSelection(serverUrl: string, id: string) {
  selection = { serverUrl, id, persisted: false }
}

/**
 * Settles the persistence attempt for a selection: marks it persisted on
 * success, clears it on failure — but only while the record still matches
 * that selection, so a late settlement for an older choice cannot vouch for
 * or destroy a newer one.
 */
export function settleThemeSelection(serverUrl: string, id: string, persisted: boolean) {
  if (selection?.serverUrl !== serverUrl || selection.id !== id) return
  if (persisted) selection = { ...selection, persisted: true }
  else selection = undefined
}

/** The theme selected in this UI against this server, if any. */
export function readThemeSelection(serverUrl: string): RecordedThemeSelection | undefined {
  return selection?.serverUrl === serverUrl ? selection : undefined
}

/**
 * Clears the recorded selection for this server; called when the recorded
 * theme is definitively unavailable so the persisted preference can take
 * over again.
 */
export function resetThemeSelection(serverUrl: string) {
  if (selection?.serverUrl === serverUrl) selection = undefined
}
