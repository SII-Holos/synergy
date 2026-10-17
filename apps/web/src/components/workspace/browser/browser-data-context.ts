import {
  BROWSER_PROTOCOL_VERSION,
  BrowserProfileDataActionSchema,
  type BrowserDataContext,
  type BrowserDataAction,
  type BrowserDataResult,
} from "@ericsanchezok/synergy-browser-core"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type { BrowserNativeViewBridge } from "@/context/platform"
import type { BrowserImportTarget } from "./browser-import-target"

type Bridge = Pick<BrowserNativeViewBridge, "createPresentationTicket" | "profileDataAction">
export async function browserDataAccess(
  input: { client: SynergyClient; bridge: Bridge; serverUrl: string; scopeID: string },
  signal?: AbortSignal,
) {
  const route = {
    path_directory: input.scopeID,
    scopeID: input.scopeID,
    mode: "scope" as const,
    protocolVersion: BROWSER_PROTOCOL_VERSION,
  }
  const response = await input.client.browser.session(
    { ...route, presentation: "auto" },
    { signal, throwOnError: true },
  )
  if (!response.data) throw new Error("Browser data is unavailable. Retry.")
  signal?.throwIfAborted()
  const ticket = await input.bridge.createPresentationTicket({
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    serverUrl: input.serverUrl,
    ownerKey: response.data.ownerKey,
  })
  if (!ticket.ok) throw ticket.error
  signal?.throwIfAborted()
  return { ...route, presentation: "native" as const, nativeTicket: ticket.ticket, ownerKey: response.data.ownerKey }
}

export async function createBrowserDataContext(input: {
  client: SynergyClient
  bridge: Bridge
  serverUrl: string
  scopeID: string
  profileId?: string
  current(): boolean
  signal: AbortSignal
}): Promise<BrowserImportTarget & { profile: BrowserDataContext["profile"]; release(): Promise<void> }> {
  const check = () => {
    input.signal.throwIfAborted()
    if (!input.current()) throw new Error("Browser data access changed. Reopen the dialog.")
  }
  check()
  if (!input.bridge.profileDataAction) throw new Error("Browser data management is unavailable in this Desktop window.")
  const native = input.bridge.profileDataAction.bind(input.bridge)
  const route = await browserDataAccess(input, input.signal)
  check()
  const response = await input.client.browser.dataContext(
    { ...route, browserDataContextInput: { profileId: input.profileId } },
    { throwOnError: true },
  )
  if (!response.data) throw new Error("Browser data access could not be prepared. Retry.")
  const context = response.data
  let released = false
  const release = async () => {
    if (released) return
    released = true
    input.signal.removeEventListener("abort", aborted)
    const cleanup = await Promise.allSettled([
      native({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        contextId: context.contextId,
        action: { type: "closeContext" },
      }),
      (async () => {
        if (!input.current()) return
        const ticket = await input.bridge.createPresentationTicket({
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          serverUrl: input.serverUrl,
          ownerKey: route.ownerKey,
        })
        if (!ticket.ok) throw ticket.error
        if (input.current())
          await input.client.browser.releaseDataContext(
            { ...route, nativeTicket: ticket.ticket, contextId: context.contextId },
            { throwOnError: true },
          )
      })(),
    ])
    const failure = cleanup.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }
  const aborted = () => {
    void release().catch(() => undefined)
  }
  input.signal.addEventListener("abort", aborted, { once: true })
  if (input.signal.aborted || !input.current()) {
    await release().catch(() => undefined)
    check()
  }
  return {
    profile: context.profile,
    release,
    current: () => !released && !input.signal.aborted && input.current(),
    action(action: BrowserDataAction): Promise<BrowserDataResult> {
      const management = BrowserProfileDataActionSchema.parse(action)
      if (management.type !== "cancelImport") {
        check()
        if (released) throw new Error("Browser data access expired. Reopen the dialog.")
      }
      if (management.type === "closeContext")
        return Promise.reject(new Error("Close the browser data dialog to release access."))
      return native({ protocolVersion: BROWSER_PROTOCOL_VERSION, contextId: context.contextId, action: management })
    },
  }
}
