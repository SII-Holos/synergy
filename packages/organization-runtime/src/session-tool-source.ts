import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionReadSource } from "@ericsanchezok/synergy-harness/session/read-source"
import {
  OrganizationSessionToolProtocol as SessionTool,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeIdentity } from "./home"
import { withMemberExecution } from "./execution-source"
import { boundSessionSource } from "./session-source"
import { OrganizationRuntimeError } from "./error"

function projected(result: SessionTool.ReadResult, query: SessionTool.ReadQuery) {
  let missingBytes = false
  const content = (value: Sync.Content) => {
    if (value.kind === "inline") return value.text
    missingBytes = true
    return `[Content bytes are not included in this shared window: ${value.bytes} bytes, SHA-256 ${value.hash}.]`
  }
  const messages = result.items.map(({ message, parts }) => {
    const text: string[] = []
    for (const { part, removed } of parts) {
      if (!part || removed) continue
      if (part.type === "text" && part.origin !== "system") text.push(content(part.content))
      else if (part.type === "tool") {
        text.push(`Tool ${part.tool}: ${part.status}${part.title ? ` — ${part.title}` : ""}`)
        for (const value of [part.input, part.output, part.error]) if (value?.kind === "blob") text.push(content(value))
      } else if (part.type === "attachment") text.push(`[Attachment: ${part.filename}, ${part.mediaType}]`)
    }
    if (!text.length && message.summary) text.push(`[Shared summary] ${message.summary}`)
    return `[${message.messageID}] ${message.role}:\n${text.join("\n") || "(No text in this shared window.)"}`
  })
  return {
    title: result.title,
    output: [
      `Shared Session: ${result.targetSessionID} — ${result.title}`,
      ...messages,
      ...(result.partial
        ? ["This shared projection window is partial. Continue with an explicit history window."]
        : []),
      ...(missingBytes ? ["Referenced content bytes require a separate authorized read; they were not loaded."] : []),
    ].join("\n\n"),
    metadata: {
      sessionID: result.targetSessionID,
      shareGeneration: result.shareGeneration,
      watermark: result.watermark,
      shown: result.items.length,
      offset: query.offset,
      ...(query.around ? { around: query.around } : {}),
      projectionOnly: true,
      partial: result.partial,
      contentBytesMissing: missingBytes,
    },
  }
}

export function registerOrganizationSessionTools(identity: RuntimeIdentity) {
  SessionReadSource.register({
    resolve(input) {
      return withMemberExecution(
        identity,
        { sessionID: input.callerSessionID, signal: input.signal },
        async (resolution, signal) => {
          const root = await Session.get(resolution.accepted.sessionID)
          try {
            await boundSessionSource(root, input.targetSessionID)
            return { kind: "native" as const }
          } catch (error) {
            if (!(error instanceof OrganizationRuntimeError) || error.data.code !== "NOT_FOUND") throw error
          }
          signal.throwIfAborted()
          const query = SessionTool.ReadQuery.parse({
            targetSessionID: input.targetSessionID,
            limit: input.limit,
            offset: input.offset,
            around: input.around,
          })
          const proof = await resolution.source.intake.descriptionProof(resolution.accepted.actor)
          const result = await resolution.source.resources.sessionRead(proof, query, signal)
          signal.throwIfAborted()
          return { kind: "projection" as const, result: projected(result, query) }
        },
      )
    },
  })
}
