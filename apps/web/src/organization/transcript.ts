import { z } from "zod"
import type { Message, Part, ToolState } from "@ericsanchezok/synergy-sdk"
import type { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"

export type OrganizationMessageEvent = Extract<Sync.Event, { type: "message" }>
export type OrganizationPartEvent = Extract<Sync.Event, { type: "part" }>
export type OrganizationMessageData = Omit<OrganizationMessageEvent, "type" | "sequence" | "integrity">
export type OrganizationPartData = Omit<OrganizationPartEvent, "type" | "sequence" | "integrity" | "part"> & {
  part?: Sync.TranscriptPart | Read.Part["part"]
}
export type OrganizationContentRead = (
  content: Exclude<Sync.Content | Read.Content, { kind: "inline" }>,
) => string | undefined

export function projectOrganizationMessage(event: OrganizationMessageData, sessionID: string): Message | undefined {
  if (event.removed || !event.agent || !event.model) return
  const base = {
    id: event.messageID,
    sessionID: event.sessionID ?? sessionID,
    actor: event.actor,
    rootID: event.rootID,
  }
  if (event.role === "user")
    return { ...base, role: "user", time: { created: event.createdAt }, agent: event.agent, model: event.model }
  if (!event.parentID || event.mode === undefined || event.cost === undefined || !event.tokens) return
  return {
    ...base,
    role: "assistant",
    time: { created: event.createdAt, completed: event.completedAt },
    parentID: event.parentID,
    modelID: event.model.modelID,
    providerID: event.model.providerID,
    mode: event.mode,
    agent: event.agent,
    path: { cwd: null, root: null },
    cost: event.cost,
    tokens: event.tokens,
    finish: event.finish,
    error: event.error
      ? { name: "UnknownError", data: { message: `${event.error.code}: ${event.error.message}` } }
      : undefined,
  }
}

function contentText(content: Sync.Content | Read.Content | undefined, read: OrganizationContentRead) {
  return content?.kind === "inline" ? content.text : content ? read(content) : undefined
}
function toolInput(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    return z.json().parse(value)
  } catch {
    return raw
  }
}

export function projectOrganizationPart(
  event: OrganizationPartData,
  rootSessionID: string,
  read: OrganizationContentRead,
): Part | undefined {
  const part = event.part
  if (event.removed || !part) return
  const base = { id: event.partID, messageID: event.messageID, sessionID: event.sessionID ?? rootSessionID }
  if (part.type === "text" || part.type === "notice") {
    const text = contentText(part.content, read)
    if (text === undefined) return
    return { ...base, type: "text", text, origin: part.type === "text" ? part.origin : "system" }
  }
  if (part.type === "compaction") return { ...base, type: "compaction", auto: part.auto }
  if (part.type === "step-start") return { ...base, type: "step-start" }
  if (part.type === "step-finish" && part.tokens)
    return { ...base, type: "step-finish", reason: part.reason, cost: part.cost, tokens: part.tokens }
  if (part.type === "reasoning") {
    const text = contentText(part.content, read)
    if (text === undefined || !part.time) return
    return { ...base, type: "reasoning", text, time: part.time }
  }
  if (part.type !== "tool") return
  const raw = contentText(part.input, read)
  if (raw === undefined) return
  const input = toolInput(raw)
  let state: ToolState
  if (part.status === "pending" || part.status === "generating") {
    const object = input && typeof input === "object" && !Array.isArray(input) ? input : {}
    state =
      part.status === "pending"
        ? { status: "pending", input: object, raw, metadata: part.metadata }
        : { status: "generating", input: object, raw, charsReceived: raw.length, metadata: part.metadata }
  } else {
    if (part.startedAt === undefined) return
    if (part.status === "running")
      state = { status: "running", input, title: part.title, metadata: part.metadata, time: { start: part.startedAt } }
    else {
      if (part.completedAt === undefined) return
      const time = { start: part.startedAt, end: part.completedAt }
      if (part.status === "completed") {
        const output = contentText(part.output, read)
        if (output === undefined) return
        state = {
          status: "completed",
          input,
          output,
          ...(part.output?.kind === "native" && part.output.original === "partial" ? { outputTruncated: true } : {}),
          title: part.title ?? part.tool,
          metadata: part.metadata ?? {},
          time,
        }
      } else {
        const error = contentText(part.error, read)
        if (error === undefined) return
        state = { status: "error", input, error, metadata: part.metadata, time }
      }
    }
  }
  return { ...base, type: "tool", callID: part.callID, tool: part.tool, state }
}

export function organizationPartBlobs(part: Sync.TranscriptPart): Extract<Sync.Content, { kind: "blob" }>[] {
  if (part.type === "text" || part.type === "reasoning" || part.type === "notice")
    return part.content.kind === "blob" ? [part.content] : []
  if (part.type !== "tool") return []
  return [part.input, part.output, part.error].filter(
    (value): value is Extract<Sync.Content, { kind: "blob" }> => value?.kind === "blob",
  )
}
