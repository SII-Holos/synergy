import type { Part } from "@ericsanchezok/synergy-sdk/client"

export interface BlueprintNoteFocusRequest {
  noteID: string
  title?: string
  scopeID?: string
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function blueprintNoteCreateFocusRequest(part: Part, sessionID: string): BlueprintNoteFocusRequest | undefined {
  if (part.sessionID !== sessionID) return undefined
  if (part.type !== "tool") return undefined
  if (part.tool !== "note_write") return undefined
  if (part.state.status !== "completed") return undefined

  const metadata = part.state.metadata ?? {}
  const input = part.state.input ?? {}
  const action = stringValue(metadata.action) ?? stringValue(input.mode) ?? "create"
  if (action !== "create") return undefined

  const kind = stringValue(metadata.kind) ?? stringValue(input.kind)
  if (kind !== "blueprint") return undefined

  const noteID = stringValue(metadata.id)
  if (!noteID) return undefined

  return {
    noteID,
    title: stringValue(metadata.title) ?? stringValue(input.title),
    scopeID: stringValue(metadata.scopeID),
  }
}
