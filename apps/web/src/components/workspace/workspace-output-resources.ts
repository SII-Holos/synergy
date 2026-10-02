import type { Message, Part } from "@ericsanchezok/synergy-sdk"
import type { WorkbenchPanelTabInit } from "@/plugin/registries/workbench-panel-registry"
import { attachmentWorkbenchPanelInit } from "@/components/attachment-workbench/model"

export function workspaceOutputResources(input: {
  message: Pick<Message, "id" | "sessionID" | "role" | "time">
  parts: Part[]
  currentSessionID: string
  scopeID: string
}) {
  const { message, parts, currentSessionID: sessionID, scopeID } = input
  const resources: Array<{
    sessionID: string
    key: string
    completedAt: number
    panelId: string
    init: WorkbenchPanelTabInit
  }> = []
  if (message.role !== "assistant" || message.sessionID !== sessionID) return resources
  for (const part of parts) {
    if (part.sessionID !== sessionID || part.messageID !== message.id) continue
    if (part.type === "attachment" && !part.mime.startsWith("image/")) {
      const init = attachmentWorkbenchPanelInit(part)
      if (init)
        resources.push({ sessionID, key: part.id, completedAt: message.time.created, panelId: "attachment", init })
      continue
    }
    if (part.type !== "tool" || part.state.status !== "completed") continue
    const metadata = part.state.metadata,
      toolInput =
        part.state.input && typeof part.state.input === "object" && !Array.isArray(part.state.input)
          ? part.state.input
          : {},
      completedAt = part.state.time.end
    if (
      part.tool === "note_write" &&
      (metadata.action ?? toolInput.mode ?? "create") === "create" &&
      typeof metadata.id === "string"
    ) {
      resources.push({
        sessionID,
        key: `${part.id}:note`,
        completedAt,
        panelId: "notes",
        init: {
          resourceId: metadata.id,
          source: typeof metadata.scopeID === "string" ? metadata.scopeID : scopeID,
          title: typeof metadata.title === "string" ? metadata.title : undefined,
        },
      })
    }
    if (
      part.tool === "browser_navigation" &&
      ["open", "goto"].includes(String(metadata.action ?? toolInput.action)) &&
      typeof metadata.pageId === "string" &&
      typeof metadata.url === "string" &&
      /^https?:\/\//.test(metadata.url)
    ) {
      resources.push({
        sessionID,
        key: `${part.id}:browser`,
        completedAt,
        panelId: "browser",
        init: { resourceId: metadata.pageId, title: metadata.url },
      })
    }
    for (const attachment of part.state.attachments ?? []) {
      if (attachment.mime.startsWith("image/")) continue
      const init = attachmentWorkbenchPanelInit(attachment)
      if (init)
        resources.push({ sessionID, key: `${part.id}:${attachment.id}`, completedAt, panelId: "attachment", init })
    }
  }
  return resources
}
