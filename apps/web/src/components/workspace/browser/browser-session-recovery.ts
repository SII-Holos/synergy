import type { BrowserAPISessionState } from "@ericsanchezok/synergy-browser"
import { shouldResumeBrowserSession } from "./browser-command"

export function createBrowserSessionRecovery(options: {
  ownerKey: string
  pageId: () => string | null
  read: (signal: AbortSignal) => Promise<BrowserAPISessionState>
  resume: (signal: AbortSignal) => Promise<void>
  reconnect: () => void
}) {
  const controller = new AbortController()
  let pending: Promise<void> | undefined
  async function recover() {
    if (controller.signal.aborted) return
    const pageId = options.pageId()
    const state = await options.read(controller.signal)
    if (controller.signal.aborted) return
    if (
      state.ownerKey !== options.ownerKey ||
      (state.status !== "active" && state.status !== "failed") ||
      !state.page ||
      state.page.id !== pageId ||
      options.pageId() !== pageId
    )
      throw new Error("The existing Browser page is no longer available for this session.")
    if (state.status === "failed" || shouldResumeBrowserSession(state)) await options.resume(controller.signal)
    if (!controller.signal.aborted && options.pageId() === pageId) options.reconnect()
  }
  return {
    run() {
      pending ??= recover().finally(() => {
        pending = undefined
      })
      return pending
    },
    dispose() {
      controller.abort()
    },
  }
}
