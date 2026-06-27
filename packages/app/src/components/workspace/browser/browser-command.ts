import type { BrowserStoreAPI } from "./browser-store"

export function createBrowserCommandId() {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `browser_cmd_${random}`
  return `browser_cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

export function browserControlCommandFromMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  switch (msg.type) {
    case "navigate":
      return { type: "navigate", source: "user", tabId: msg.tabId, url: String(msg.url ?? "") }
    case "reload":
      return { type: "reload", tabId: msg.tabId }
    case "stop":
      return { type: "stop", tabId: msg.tabId }
    case "history":
      if (msg.direction !== "back" && msg.direction !== "forward") return null
      return { type: "history", tabId: msg.tabId, direction: msg.direction }
    case "createTab":
      return typeof msg.url === "string" ? { type: "createTab", url: msg.url } : { type: "createTab" }
    case "closeTab":
      return { type: "closeTab", tabId: String(msg.tabId ?? "") }
    case "switchTab":
      return { type: "switchTab", tabId: String(msg.tabId ?? "") }
    case "input.resize":
      return {
        type: "setViewport",
        tabId: msg.tabId,
        width: Number(msg.width),
        height: Number(msg.height),
      }
    case "input.mouse":
      if (msg.action !== "move" && msg.action !== "down" && msg.action !== "up" && msg.action !== "wheel") return null
      return { type: "mouse", tabId: msg.tabId, action: msg.action, input: msg }
    case "input.key":
      if (msg.action !== "down" && msg.action !== "up") return null
      return { type: "key", tabId: msg.tabId, action: msg.action, input: msg }
    case "input.text":
      return { type: "insertText", tabId: msg.tabId, text: String(msg.text ?? "") }
    case "requestConsole":
      return { type: "console", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestNetwork":
      return { type: "network", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestSnapshot":
      return { type: "snapshot", tabId: msg.tabId }
    case "requestAssets":
      return { type: "assets", tabId: msg.tabId, maxEntries: msg.maxEntries }
    case "requestScreenshot":
      return { type: "screenshot", tabId: msg.tabId }
    case "filechooser.select":
      return {
        type: "filechooser.select",
        tabId: msg.tabId,
        requestId: String(msg.requestId ?? ""),
        files: msg.files ?? [],
      }
    case "dialog.respond":
      return {
        type: "dialog.respond",
        tabId: msg.tabId,
        requestId: String(msg.requestId ?? ""),
        accept: Boolean(msg.accept),
        promptText: msg.promptText,
      }
    case "createAnnotation":
      return {
        type: "createAnnotation",
        tabId: msg.tabId,
        comment: String(msg.comment ?? ""),
        styleFeedback: msg.styleFeedback,
      }
    case "clearLogs":
      return { type: "clearDiagnostics", tabId: msg.tabId }
    case "setFollowAgent":
    case "followAgentNow":
      return null
    default:
      return null
  }
}

export function applyBrowserControlResult(store: BrowserStoreAPI, result: any) {
  switch (result?.type) {
    case "tab":
      store.upsertTab(result.tab)
      store.activateTabFromServer(result.tab.id)
      if (typeof result.hostStatus === "string") store.setHostStatus(result.tab.id, result.hostStatus)
      break
    case "navigation":
      store.upsertTab(result.tab)
      store.setTabLoading(result.tab.id, false)
      break
    case "session":
      store.setSession("tabs", result.session?.tabs ?? [])
      store.setSession("activeTabId", result.session?.activeTabId ?? null)
      if (!store.session.visibleTabId) store.setSession("visibleTabId", result.session?.activeTabId ?? null)
      break
    case "console":
      store.setConsoleEntries(result.tabId, result.entries ?? [])
      break
    case "network":
      store.setNetworkRequests(result.tabId, result.requests ?? [])
      break
    case "snapshot":
      store.setElements(result.tabId, result.elements ?? [])
      break
    case "assets":
      store.setPageAssets(result.tabId, result.assets ?? [])
      break
    case "screenshot":
      store.setTabScreenshots(result.tabId, {
        url: result.dataUrl,
        width: result.width ?? 0,
        height: result.height ?? 0,
      })
      break
    case "diagnostics.cleared":
      store.setConsoleEntries(result.tabId, [])
      store.setNetworkRequests(result.tabId, [])
      store.setPageAssets(result.tabId, [])
      break
  }
}
