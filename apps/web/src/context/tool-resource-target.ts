import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"

const browserTools = new Set([
  "browser_navigation",
  "browser_action",
  "browser_read",
  "browser_snapshot",
  "browser_screenshot",
  "browser_inspect",
  "browser_wait",
  "browser_console",
  "browser_network",
  "browser_eval",
  "browser_emulate",
  "browser_dialog",
  "browser_clipboard",
  "browser_audit",
  "browser_assets",
  "browser_upload",
  "browser_performance",
])

export type ToolResourceTarget = { panelId: "notes" | "browser"; resourceId: string; source?: string }

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function supportsToolResource(tool: string) {
  return tool === "note_write" || tool === "note_edit" || tool === "note_read" || browserTools.has(tool)
}

export function toolResourceTarget(part: ToolPart): ToolResourceTarget | undefined {
  if (part.state.status !== "completed") return
  const input =
    part.state.input && typeof part.state.input === "object" && !Array.isArray(part.state.input) ? part.state.input : {}
  const metadata: Record<string, unknown> = part.state.metadata ?? {}
  if (metadata.blocked || metadata.conflict || metadata.errorCode || metadata.dryRun) return
  if (part.tool === "note_write" || part.tool === "note_edit") {
    const resourceId = text(metadata.id)
    if (resourceId) return { panelId: "notes", resourceId, source: text(metadata.scopeID) }
  }
  if (part.tool === "note_read" && metadata.count === 1 && Array.isArray(input.noteIds) && input.noteIds.length === 1) {
    const resourceId = text(input.noteIds[0])
    if (resourceId) return { panelId: "notes", resourceId }
  }
  if (!browserTools.has(part.tool)) return
  if (part.tool === "browser_navigation" && (input.action === "list" || input.action === "close")) return
  const resourceId = text(metadata.pageId)
  if (resourceId) return { panelId: "browser", resourceId }
}
