import type { DesktopPowerBridge, DesktopPowerSnapshot } from "@/context/platform"

export type DesktopPowerControllerOptions = {
  bridge: DesktopPowerBridge | undefined
  /** Reports a successfully applied keep-awake state. */
  onApplied: (snapshot: DesktopPowerSnapshot) => void
  /** Reports a failed apply; called at most once per failure episode. */
  onFailure: (error: unknown) => void
}

export type DesktopPowerController = {
  /** Apply a keep-awake state immediately. On failure, re-syncs to the live value. */
  apply(keepAwakeWhileRunning: boolean): void
  /** Re-read the live keep-awake state from the bridge. */
  restore(): Promise<void>
}

export function createDesktopPowerController(options: DesktopPowerControllerOptions): DesktopPowerController {
  let failureNotified = false

  function apply(keepAwakeWhileRunning: boolean) {
    const bridge = options.bridge
    if (!bridge) return
    void bridge
      .set({ keepAwakeWhileRunning })
      .then((snapshot) => {
        failureNotified = false
        options.onApplied(snapshot)
      })
      .catch((error) => {
        if (!failureNotified) {
          failureNotified = true
          options.onFailure(error)
        }
        // The set never landed; re-read the live state so the toggle reflects
        // what the shell is actually enforcing.
        void bridge
          .get()
          .then(options.onApplied)
          .catch(() => undefined)
      })
  }

  async function restore() {
    const bridge = options.bridge
    if (!bridge) return
    const snapshot = await bridge.get().catch(() => undefined)
    if (snapshot) options.onApplied(snapshot)
  }

  return { apply, restore }
}
