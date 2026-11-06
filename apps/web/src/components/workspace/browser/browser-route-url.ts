import { BROWSER_PROTOCOL_VERSION, type BrowserPresentationPreference } from "@ericsanchezok/synergy-browser-core"

export type BrowserWebSocketUrlOptions = {
  serverUrl: string
  sessionID?: string
  mode?: "scope" | "session"
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  presentation?: BrowserPresentationPreference
  traceId?: string
  sinceSeq?: number
  epoch?: string | null
  nativeTicket?: string
}

export function createBrowserEventsWebSocketUrl(options: BrowserWebSocketUrlOptions) {
  return createBrowserRouteUrl(options, "events", "ws")
}

function createBrowserRouteUrl(options: BrowserWebSocketUrlOptions, route: "events", scheme: "ws") {
  const pathDirectory = options.routeDirectory ?? options.directory ?? options.scopeID ?? options.scopeKey
  if (!pathDirectory) return null

  const params = new URLSearchParams({
    mode: options.mode ?? (options.sessionID ? "session" : "scope"),
    presentation: options.presentation ?? "auto",
    protocolVersion: String(BROWSER_PROTOCOL_VERSION),
  })
  if ((options.mode ?? (options.sessionID ? "session" : "scope")) === "session") {
    if (!options.sessionID) return null
    params.set("sessionID", options.sessionID)
  }
  if (options.scopeID) params.set("scopeID", options.scopeID)
  else if (options.directory) params.set("directory", options.directory)
  if (options.traceId) params.set("traceId", options.traceId)
  if (options.sinceSeq !== undefined) params.set("sinceSeq", String(options.sinceSeq))
  if (options.epoch) params.set("epoch", options.epoch)
  if (options.nativeTicket) params.set("nativeTicket", options.nativeTicket)

  const baseUrl = options.serverUrl.replace(/^http/, "ws")
  return baseUrl + `/${encodeURIComponent(pathDirectory)}/browser/${route}?${params.toString()}`
}
