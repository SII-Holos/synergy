import type { Accessor } from "solid-js"
import type { PaneSnapshot } from "../model/pane-selection"

export function createPaneAccessor(snapshot: Accessor<PaneSnapshot>, key: string) {
  // A keyed row's cleanup still needs its owner after the next snapshot removes that key.
  let pane = snapshot().map.get(key)!
  return () => (pane = snapshot().map.get(key) ?? pane)
}
