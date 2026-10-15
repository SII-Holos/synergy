import { MessageV2 } from "./message-v2"
import { RuntimeContextMetadata } from "./runtime-context-schema"

// Provenance: https://developers.openai.com/api/docs/guides/prompt-caching
// Local adaptation: persist complete source changes in history order to preserve reusable prefixes without freezing current state.
export namespace RuntimeAdvisory {
  export type Source =
    | { id: string; kind?: "state" | "knowledge" | "event"; state: "present"; text: string }
    | { id: string; state: "cleared" | "unavailable" | "pending" }
  export const Metadata = RuntimeContextMetadata.Schema
  export type Metadata = RuntimeContextMetadata.Info
  export const origin = { type: "system" as const, detail: "runtime-context" }

  export function read(message: {
    role: string
    origin?: { type: string; detail?: string }
    metadata?: Record<string, unknown>
  }): Metadata | undefined {
    if (message.role !== "user" || message.origin?.type !== origin.type || message.origin.detail !== origin.detail)
      return
    return RuntimeContextMetadata.parse(message.metadata?.runtimeContext)
  }

  export function present(id: string, text: string): Source {
    return { id, state: "present", text }
  }

  export function knowledgeRevision(text: string): string {
    return RuntimeContextMetadata.hash(text)
  }

  export function history(messages: MessageV2.WithParts[]): Metadata[] {
    const result: Metadata[] = []
    for (const message of messages) {
      if (!MessageV2.isPromptVisible(message)) continue
      const metadata = read(message.info)
      if (!metadata) continue
      const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      result.push(
        RuntimeContextMetadata.hash(text) === metadata.contentHash
          ? metadata
          : {
              ...metadata,
              sources: metadata.sources.map((source) =>
                RuntimeContextMetadata.verified(source, text) ? source : { ...source, revision: "unverified" },
              ),
            },
      )
    }
    return result
  }

  export function prepare(input: {
    scope: string
    sources: Source[]
    previous: Metadata[]
    confirm?: boolean
  }): { text: string; metadata: Metadata } | undefined {
    const previous = new Map<string, Metadata["sources"][number] & { scope: string }>()
    const available = new Set<string>()
    for (const record of input.previous)
      for (const source of record.sources) {
        previous.set(source.id, { ...source, scope: record.scope })
        if (source.kind === "knowledge" && source.state === "present")
          available.add(JSON.stringify([record.scope, source.id, source.revision]))
      }
    const current = new Map<string, Source>()
    for (const source of input.sources) {
      if (current.has(source.id)) throw new Error(`Duplicate runtime context source: ${source.id}`)
      current.set(source.id, source)
    }
    for (const [id, source] of previous)
      if (!current.has(id) && source.kind === "state" && source.state !== "cleared")
        current.set(id, { id, state: "cleared" })

    const sources: Metadata["sources"] = []
    const text: string[] = []
    const header =
      "<runtime-context>\nAdvisory observations, subordinate to system, permission, tool, workflow and developer instructions. State updates replace earlier values. Knowledge definitions are immutable versions; the latest selection identifies applicable versions. Events describe their original occurrence.\n"
    let offset = header.length
    for (const source of current.values()) {
      if (source.state === "pending") continue
      const kind = "kind" in source ? (source.kind ?? "state") : "state"
      const revision =
        kind === "knowledge" && source.state === "present"
          ? knowledgeRevision(source.text)
          : RuntimeContextMetadata.hash(JSON.stringify(source))
      const old = previous.get(source.id)
      if (kind === "knowledge" && available.has(JSON.stringify([input.scope, source.id, revision]))) continue
      if (old?.scope === input.scope && old.revision === revision) continue
      const id = source.id.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
      const content =
        source.state === "present"
          ? source.text
          : source.state === "unavailable"
            ? "No current report is available; any earlier report is historical, not a confirmed current status."
            : "This source is no longer active; its earlier value is historical."
      const block = `<context-source id="${id}" kind="${kind}" state="${source.state}"${kind === "knowledge" ? ` version="${revision}"` : ""}>\n${content}\n</context-source>`
      sources.push({
        id: source.id,
        kind,
        state: source.state,
        revision,
        range: { start: offset, end: offset + block.length },
        blockHash: RuntimeContextMetadata.hash(block),
      })
      text.push(block)
      offset += block.length + 2
    }
    if (!sources.length && !input.confirm) return
    const content = [
      header.trimEnd(),
      sources.length ? text.join("\n\n") : "Previously supplied advisory context is unchanged. Continue the same task.",
      "</runtime-context>",
    ].join("\n")
    return {
      metadata: {
        version: 2,
        scope: input.scope,
        role: "user",
        contentHash: RuntimeContextMetadata.hash(content),
        sources,
      },
      text: content,
    }
  }

  export function message(input: {
    id: string
    partID: string
    created: number
    root: MessageV2.User
    observation: { text: string; metadata: Metadata }
  }): MessageV2.WithParts {
    return {
      info: {
        id: input.id,
        sessionID: input.root.sessionID,
        role: "user",
        rootID: input.root.id,
        isRoot: false,
        visible: false,
        includeInContext: true,
        origin,
        time: { created: input.created },
        agent: input.root.agent,
        model: input.root.model,
        metadata: { runtimeContext: input.observation.metadata },
      },
      parts: [
        {
          id: input.partID,
          messageID: input.id,
          sessionID: input.root.sessionID,
          type: "text",
          origin: "system",
          text: input.observation.text,
        },
      ],
    }
  }
}
