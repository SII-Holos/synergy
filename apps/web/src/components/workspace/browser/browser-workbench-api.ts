import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import type { useSDK } from "@/context/sdk"
import type { BrowserNativeViewBridge } from "@/context/platform"
import { createBrowserCommandId } from "./browser-command"
import { browserPageTab, type BrowserWorkbenchRoute } from "./browser-workbench-model"

type Client = ReturnType<typeof useSDK>["client"]
export async function browserWorkbenchAccess(input: {
  client: Client
  serverUrl: string
  bridge: BrowserNativeViewBridge | undefined
  route: BrowserWorkbenchRoute
}) {
  if (!input.bridge) throw new Error("Open the browser in Desktop.")
  const state = await input.client.browser.session(
    { ...input.route, mode: "session", presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
    { throwOnError: true },
  )
  if (!state.data) throw new Error("Browser state could not be loaded. Retry.")
  const ticket = await input.bridge.createPresentationTicket({
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    serverUrl: input.serverUrl,
    ownerKey: state.data.ownerKey,
  })
  if (!ticket.ok) throw ticket.error
  return { ...input.route, mode: "session" as const, presentation: "native" as const, nativeTicket: ticket.ticket }
}
export async function openBrowserWorkbenchPage(input: Parameters<typeof browserWorkbenchAccess>[0]) {
  const response = await input.client.browser.openPage(
    {
      ...(await browserWorkbenchAccess(input)),
      browserOpenPage: { requestId: createBrowserCommandId(), url: "about:blank" },
    },
    { throwOnError: true },
  )
  if (!response.data) throw new Error("Page could not be opened. Retry.")
  return browserPageTab(response.data, input.route)
}
export async function closeBrowserWorkbenchPage(
  input: Parameters<typeof browserWorkbenchAccess>[0] & { pageId: string },
) {
  const route = await browserWorkbenchAccess(input)
  await input.client.browser.control(
    {
      ...route,
      browserControlRequest: {
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId: input.pageId,
        commandId: createBrowserCommandId(),
        command: { type: "close" },
      },
    },
    { throwOnError: true },
  )
}
