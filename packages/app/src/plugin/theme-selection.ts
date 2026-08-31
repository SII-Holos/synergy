let selection: string | undefined

/**
 * Records a theme selection made in this UI for the current page's lifetime.
 * Module state on purpose: the plugin bridge remounts on session transitions,
 * and the record must survive those remounts so a config fetch racing the
 * selection's fire-and-forget persistence cannot replay the stale value.
 */
export function recordThemeSelection(id: string) {
  selection = id
}

/** The theme selected in this UI during the current page's lifetime, if any. */
export function readThemeSelection(): string | undefined {
  return selection
}

/** Resets the recorded selection; test isolation only. */
export function resetThemeSelection() {
  selection = undefined
}
