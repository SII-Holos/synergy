import type { BrowserStoreAPI } from "./browser-store"

export function createBrowserCommandId() {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `browser_cmd_${random}`
  return `browser_cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

export function browserControlCommandFromMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  switch (msg.type) {
    case "navigate":
      return { type: "navigate", source: "user", pageId: msg.pageId, url: String(msg.url ?? "") }
    case "reload":
      return { type: "reload", pageId: msg.pageId }
    case "stop":
      return { type: "stop", pageId: msg.pageId }
    case "history":
      if (msg.direction !== "back" && msg.direction !== "forward") return null
      return { type: "history", pageId: msg.pageId, direction: msg.direction }
    case "input.resize":
      return {
        type: "setViewport",
        pageId: msg.pageId,
        width: Number(msg.width),
        height: Number(msg.height),
      }
    case "click":
      return { type: "click", pageId: msg.pageId, x: Number(msg.x), y: Number(msg.y) }
    case "input.mouse":
      if (msg.action !== "move" && msg.action !== "down" && msg.action !== "up" && msg.action !== "wheel") return null
      return { type: "mouse", pageId: msg.pageId, action: msg.action, input: msg }
    case "input.key":
      if (msg.action !== "down" && msg.action !== "up") return null
      return { type: "key", pageId: msg.pageId, action: msg.action, input: msg }
    case "input.text":
      return { type: "insertText", pageId: msg.pageId, text: String(msg.text ?? "") }
    case "requestConsole":
      return { type: "console", pageId: msg.pageId, maxEntries: msg.maxEntries }
    case "requestNetwork":
      return { type: "network", pageId: msg.pageId, maxEntries: msg.maxEntries }
    case "requestSnapshot":
      return { type: "snapshot", pageId: msg.pageId }
    case "requestAssets":
      return { type: "assets", pageId: msg.pageId, maxEntries: msg.maxEntries }
    case "requestScreenshot":
      return { type: "screenshot", pageId: msg.pageId }
    case "filechooser.select":
      return {
        type: "filechooser.select",
        pageId: msg.pageId,
        requestId: String(msg.requestId ?? ""),
        files: msg.files ?? [],
      }
    case "dialog.respond":
      return {
        type: "dialog.respond",
        pageId: msg.pageId,
        requestId: String(msg.requestId ?? ""),
        accept: Boolean(msg.accept),
        promptText: msg.promptText,
      }
    case "createAnnotation":
      return {
        type: "createAnnotation",
        pageId: msg.pageId,
        comment: String(msg.comment ?? ""),
        styleFeedback: msg.styleFeedback,
      }
    case "clearLogs":
      return { type: "clearDiagnostics", pageId: msg.pageId }
    case "setFollowAgent":
    case "followAgentNow":
      return null
    default:
      return null
  }
}

export function applyBrowserControlResult(store: BrowserStoreAPI, result: any) {
  switch (result?.type) {
    case "page":
      store.upsertPage(result.page)
      if (typeof result.hostStatus === "string") store.setHostStatus(result.page?.id, result.hostStatus)
      break
    case "navigation":
      store.upsertPage(result.page)
      store.setPageLoading(result.page?.id, false)
      if (typeof result.hostStatus === "string") store.setHostStatus(result.page?.id, result.hostStatus)
      break
    case "session":
      store.setSession("page", result.session?.page ?? null)
      break
    case "console":
      store.setConsoleEntries(result.pageId, result.entries ?? [])
      break
    case "network":
      store.setNetworkRequests(result.pageId, result.requests ?? [])
      break
    case "snapshot":
      store.setElements(result.pageId, result.elements ?? [])
      break
    case "assets":
      store.setPageAssets(result.pageId, result.assets ?? [])
      break
    case "screenshot":
      store.setPageScreenshots(result.pageId, {
        url: result.dataUrl,
        width: result.width ?? 0,
        height: result.height ?? 0,
      })
      break
    case "diagnostics.cleared":
      store.setConsoleEntries(result.pageId, [])
      store.setNetworkRequests(result.pageId, [])
      store.setPageAssets(result.pageId, [])
      break
  }
}
