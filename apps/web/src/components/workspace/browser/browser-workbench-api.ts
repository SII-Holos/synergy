import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import type { useSDK } from "@/context/sdk"
import type { BrowserNativeViewBridge } from "@/context/platform"
import { createBrowserCommandId } from "./browser-command"
import { browserPageTab, type BrowserWorkbenchRoute } from "./browser-workbench-model"

type Client = ReturnType<typeof useSDK>["client"]
export interface BrowserWorkbenchOpenSelection {
  ownerKey?: string
  epoch?: string
  newPage?: boolean
  pageId?: string
}
async function loadAccess(input: {
  client: Client
  serverUrl: string
  bridge: BrowserNativeViewBridge | undefined
  route: BrowserWorkbenchRoute
}) {
  if (!input.bridge) throw new Error("Open the browser in Desktop.")
  const state = await input.client.browser.session(
    { ...input.route, presentation: "auto", protocolVersion: BROWSER_PROTOCOL_VERSION },
    { throwOnError: true },
  )
  if (!state.data) throw new Error("Browser state could not be loaded. Retry.")
  const ticket = await input.bridge.createPresentationTicket({
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    serverUrl: input.serverUrl,
    ownerKey: state.data.ownerKey,
  })
  if (!ticket.ok) throw ticket.error
  const route = { ...input.route, ownerKey: state.data.ownerKey, serverUrl: input.serverUrl }
  return { state: state.data, route, query: { ...route, presentation: "native" as const, nativeTicket: ticket.ticket } }
}
export async function browserWorkbenchAccess(input: Parameters<typeof loadAccess>[0]) {
  return (await loadAccess(input)).query
}
export async function openBrowserWorkbenchPage(
  input: Parameters<typeof browserWorkbenchAccess>[0] & {
    restore?: boolean
    url?: string
    pageId?: string
    requestId?: string
    selection?: BrowserWorkbenchOpenSelection
    onCreated?(tab: ReturnType<typeof browserPageTab>): void | Promise<void>
  },
) {
  const access = await loadAccess(input)
  const selection = input.selection
  if (
    selection?.ownerKey &&
    (selection.ownerKey !== access.state.ownerKey || (selection.epoch && selection.epoch !== access.state.epoch))
  )
    throw new Error("Browser availability changed. Reopen the browser page.")
  const pageId = input.pageId ?? selection?.pageId
  const latest = pageId
    ? access.state.pages?.find((page) => page.id === pageId)
    : input.restore && !selection?.newPage
      ? [...(access.state.pages ?? [])].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
      : undefined
  if (pageId && !latest) throw new Error("The browser page has closed. Reopen the browser page.")
  if (selection) {
    selection.ownerKey = access.state.ownerKey
    selection.epoch = access.state.epoch
    if (latest) selection.pageId = latest.id
    else selection.newPage = true
  }
  if (latest) {
    if (latest.status === "active") return browserPageTab(latest, access.route)
    const resumed = await input.client.browser.control(
      {
        ...access.query,
        browserControlRequest: {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          pageId: latest.id,
          commandId: input.requestId ?? createBrowserCommandId(),
          command: { type: "resume" },
        },
      },
      { throwOnError: true },
    )
    if (!resumed.data || resumed.data.result.type !== "page") throw new Error("Page could not be resumed. Retry.")
    return browserPageTab(resumed.data.result.page, access.route)
  }
  const response = await input.client.browser.openPage(
    {
      ...access.query,
      browserOpenPage: { requestId: input.requestId ?? createBrowserCommandId(), url: input.url ?? "about:blank" },
    },
    { throwOnError: true },
  )
  if (!response.data) throw new Error("Page could not be opened. Retry.")
  const tab = browserPageTab(response.data, access.route)
  if (selection) selection.pageId = response.data.id
  await input.onCreated?.(tab)
  return tab
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
