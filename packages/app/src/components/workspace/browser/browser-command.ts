import type { BrowserStoreAPI } from "./browser-store"
import type { BrowserBackendResult } from "@ericsanchezok/synergy-browser"

export function createBrowserCommandId() {
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return `browser_cmd_${random}`
  return `browser_cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

export function browserControlCommandFromMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  switch (msg.type) {
    case "navigate":
      return { type: "navigate", source: "user", url: String(msg.url ?? "") }
    case "reload":
      return { type: "reload" }
    case "stop":
      return { type: "stop" }
    case "history":
      if (msg.direction !== "back" && msg.direction !== "forward") return null
      return { type: "history", direction: msg.direction }
    case "input.resize":
      return {
        type: "setViewport",
        width: Number(msg.width),
        height: Number(msg.height),
      }
    case "resume":
      return { type: "resume" }
    case "close":
      return { type: "close" }
    case "filechooser.select":
      return {
        type: "filechooser.select",
        requestId: String(msg.requestId ?? ""),
        files: msg.files ?? [],
      }
    case "dialog.respond":
      return {
        type: "dialog.respond",
        requestId: String(msg.requestId ?? ""),
        accept: Boolean(msg.accept),
        promptText: msg.promptText,
      }
    case "setFollowAgent":
    case "followAgentNow":
      return null
    default:
      return null
  }
}

export function applyBrowserControlResult(store: BrowserStoreAPI, result: BrowserBackendResult) {
  switch (result.type) {
    case "page":
      store.upsertPage(result.page)
      break
    case "navigation":
      store.upsertPage(result.page)
      store.setPageLoading(result.page.id, false)
      break
  }
}
