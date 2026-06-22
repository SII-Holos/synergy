import { onCleanup } from "solid-js"
import type { BrowserStore } from "./browser-store"

interface Props {
  store: BrowserStore
  active: boolean
  onAnnotation: (selector: string, comment: string, styleFeedback?: Record<string, string>) => void
}

export function AnnotationOverlay(props: Props) {
  // Placeholder for annotation mode overlay.
  // Full implementation in future: element highlighting, region selection, comment popup.
  return null
}
