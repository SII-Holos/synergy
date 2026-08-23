import type { DesktopZoomBridge } from "@/context/platform"

export type DesktopZoomControllerOptions = {
  bridge: DesktopZoomBridge | undefined
  /** Reports a successfully applied zoom factor. */
  onApplied: (factor: number) => void
  /** Reports a failed apply; called at most once per failure episode. */
  onFailure: (error: unknown) => void
}

export type DesktopZoomController = {
  /** Apply a zoom factor immediately. On failure, re-syncs to the live value. */
  apply(factor: number): void
  /** Re-read the live zoom factor from the bridge. */
  restore(): Promise<void>
}

export function createDesktopZoomController(options: DesktopZoomControllerOptions): DesktopZoomController {
  let failureNotified = false

  function apply(factor: number) {
    const bridge = options.bridge
    if (!bridge) return
    void bridge
      .set(factor)
      .then((applied) => {
        failureNotified = false
        options.onApplied(applied)
      })
      .catch((error) => {
        if (!failureNotified) {
          failureNotified = true
          options.onFailure(error)
        }
        // The set never landed; re-read the live factor so the slider reflects
        // the actually applied zoom instead of the dragged, never-applied value.
        void bridge
          .get()
          .then(options.onApplied)
          .catch(() => undefined)
      })
  }

  async function restore() {
    const bridge = options.bridge
    if (!bridge) return
    const factor = await bridge.get().catch(() => undefined)
    if (factor !== undefined) options.onApplied(factor)
  }

  return { apply, restore }
}
