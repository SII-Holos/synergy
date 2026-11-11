import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { OrganizationRuntimeError } from "./error"
import type { NativeContentReader, NativeAttachmentReader } from "./session-read"
import { projectToolMetadata } from "./transcript"

function unavailable(message: string) {
  return new OrganizationRuntimeError({
    code: "RESOURCE_UNAVAILABLE",
    message,
    retryable: false,
    outcome: "not_dispatched",
  })
}

export const readNativeAttachment: NativeAttachmentReader = async (query, source, signal) => {
  try {
    const result = await SessionHistory.attachmentContent({
      sessionID: source.id,
      messageID: query.messageID,
      partID: query.partID,
      version: query.version,
      offset: query.offset,
      length: query.length,
      signal,
    })
    const target = { messageID: query.messageID, partID: query.partID }
    if (result.state === "unavailable") return { ...target, ...result }
    return {
      ...target,
      state: "ready",
      reference: { kind: "attachment", ...result.descriptor },
      chunk: {
        offset: result.offset,
        nextOffset: result.nextOffset,
        totalBytes: result.descriptor.bytes,
        sha256: result.descriptor.sha256,
        data: Buffer.from(result.data).toString("base64url"),
        complete: result.complete,
      },
    }
  } catch (error) {
    if (error instanceof SessionHistory.PartFieldConflict)
      throw new OrganizationRuntimeError({
        code: "REVISION_CONFLICT",
        message: "Native attachment content changed",
        retryable: false,
        outcome: "not_dispatched",
      })
    throw error
  }
}

export const readNativeContent: NativeContentReader = async (query, source, signal) => {
  try {
    const target = { sessionID: source.id, messageID: query.messageID, partID: query.partID, signal }
    const descriptor = await SessionHistory.preparePartFields(target)
    if (query.version !== undefined && query.version !== descriptor.version)
      throw new OrganizationRuntimeError({
        code: "REVISION_CONFLICT",
        message: "Native part content changed",
        retryable: false,
        outcome: "not_dispatched",
      })
    if (descriptor.state === "preparing")
      return {
        state: "preparing",
        messageID: query.messageID,
        partID: query.partID,
        version: descriptor.version,
        progress: { phase: descriptor.phase, bytes: descriptor.completedBytes },
      }
    const { header, version } = descriptor
    const content = (field: "text" | "input" | "output" | "error"): Read.Content => {
      const selected = descriptor.fields.find((value) => value.field === field)
      if (!selected) throw unavailable("The requested native field is not retained")
      return {
        kind: "native",
        version,
        field,
        bytes: selected.bytes,
        sha256: selected.sha256,
        original: selected.original,
      }
    }
    let part: Read.Part["part"]
    switch (header.type) {
      case "text":
        part = { type: "text", content: content("text"), origin: MessageV2.isSystemPart(header) ? "system" : "user" }
        break
      case "reasoning":
        part = { type: "reasoning", content: content("text"), time: header.time }
        break
      case "tool": {
        const state = header.state
        part = {
          type: "tool",
          callID: header.callID,
          tool: header.tool,
          status: state.status,
          input: content("input"),
          ...(descriptor.fields.some((value) => value.field === "output") ? { output: content("output") } : {}),
          ...(descriptor.fields.some((value) => value.field === "error") ? { error: content("error") } : {}),
          ...("title" in state && state.title ? { title: (await SecretMask.apply(state.title)).slice(0, 1024) } : {}),
          ...("time" in state ? { startedAt: state.time.start } : {}),
          ...("time" in state && "end" in state.time ? { completedAt: state.time.end } : {}),
          metadata: await projectToolMetadata(header.tool, "metadata" in state ? state.metadata : undefined),
        }
        break
      }
      case "attachment":
        part = {
          type: "attachment",
          filename: ((header.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment").slice(0, 512),
          mediaType: header.mime,
          ...(header.artifact?.sha256 ? { hash: header.artifact.sha256, bytes: header.artifact.bytes } : {}),
        }
        break
      case "step-start":
        part = { type: "step-start" }
        break
      case "step-finish":
        part = { type: "step-finish", reason: header.reason, cost: header.cost, tokens: header.tokens }
        break
      case "compaction":
        part = { type: "compaction", auto: header.auto }
        break
      case "compaction_recovery":
        part = { type: "notice", kind: "compaction-recovery", content: content("text") }
        break
      case "retry":
        part = {
          type: "notice",
          kind: "retry",
          content: { kind: "inline", text: (await SecretMask.apply(header.error.name)).slice(0, 256) },
        }
        break
      default:
        throw unavailable("This native part has no portable transcript presentation")
    }
    const value = Read.Part.parse({ partID: query.partID, messageID: query.messageID, version, part })
    if (!descriptor.fields.some((field) => field.field === query.field)) return { state: "ready", value }
    const result = await SessionHistory.partField({
      ...target,
      field: query.field,
      version,
      offset: query.offset,
      length: query.length,
    })
    return {
      state: "ready",
      value,
      chunk: Read.Chunk.parse({
        field: query.field,
        offset: result.offset,
        nextOffset: result.nextOffset,
        totalBytes: result.totalBytes,
        sha256: result.sha256,
        original: result.original,
        data: Buffer.from(result.data).toString("base64url"),
        complete: result.complete,
      }),
    }
  } catch (error) {
    if (error instanceof SessionHistory.PartFieldConflict)
      throw new OrganizationRuntimeError(
        {
          code: "REVISION_CONFLICT",
          message: "Native part content changed",
          retryable: false,
          outcome: "not_dispatched",
        },
        { cause: error },
      )
    throw error
  }
}
