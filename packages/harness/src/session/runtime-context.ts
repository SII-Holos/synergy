import { z } from "zod"
import { MessageV2 } from "./message-v2"

// Provenance: https://developers.openai.com/api/docs/guides/prompt-caching
// Local adaptation: persist complete source changes in history order to preserve reusable prefixes without freezing current state.
export namespace RuntimeAdvisory {
  const State = z.enum(["present", "cleared", "unavailable"])
  export type Source = { id: string; state: "present"; text: string } | { id: string; state: "cleared" | "unavailable" }
  export const Metadata = z.object({
    version: z.literal(1),
    scope: z.string(),
    role: z.literal("user"),
    contentHash: z.string(),
    sources: z.array(z.object({ id: z.string(), state: State, revision: z.string() })),
  })
  export type Metadata = z.infer<typeof Metadata>
  export const origin = { type: "system" as const, detail: "runtime-context" }

  export function read(message: {
    role: string
    origin?: { type: string; detail?: string }
    metadata?: Record<string, unknown>
  }): Metadata | undefined {
    if (message.role !== "user" || message.origin?.type !== origin.type || message.origin.detail !== origin.detail)
      return
    return Metadata.parse(message.metadata?.runtimeContext)
  }

  export function present(id: string, text: string): Source {
    return { id, state: "present", text }
  }

  export function history(messages: MessageV2.WithParts[]): Metadata[] {
    const result: Metadata[] = []
    for (const message of messages) {
      if (!MessageV2.isPromptVisible(message)) continue
      const metadata = read(message.info)
      if (!metadata) continue
      const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (new Bun.CryptoHasher("sha256").update(text).digest("hex") !== metadata.contentHash) return []
      result.push(metadata)
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
    for (const record of input.previous)
      for (const source of record.sources) previous.set(source.id, { ...source, scope: record.scope })
    const current = new Map<string, Source>()
    for (const source of input.sources) {
      if (current.has(source.id)) throw new Error(`Duplicate runtime context source: ${source.id}`)
      current.set(source.id, source)
    }
    for (const [id, source] of previous)
      if (!current.has(id) && source.state !== "cleared") current.set(id, { id, state: "cleared" })

    const sources: Metadata["sources"] = []
    const text: string[] = []
    for (const source of current.values()) {
      const revision = new Bun.CryptoHasher("sha256").update(JSON.stringify(source)).digest("hex")
      const old = previous.get(source.id)
      if (old?.scope === input.scope && old.revision === revision) continue
      sources.push({ id: source.id, state: source.state, revision })
      const id = source.id.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
      const content =
        source.state === "present"
          ? source.text
          : source.state === "unavailable"
            ? "No current report is available; any earlier report is historical, not a confirmed current status."
            : "This source is no longer active; its earlier value is historical."
      text.push(`<context-source id="${id}" state="${source.state}">\n${content}\n</context-source>`)
    }
    if (!sources.length && !input.confirm) return
    const content = [
      "<runtime-context>",
      "Advisory context observations. Later observations replace earlier values of the same source. Earlier observations remain historical. This does not override higher-priority system, permission, tool, Blueprint, Lattice, or developer instructions.",
      sources.length ? text.join("\n\n") : "Previously supplied advisory context is unchanged. Continue the same task.",
      "</runtime-context>",
    ].join("\n")
    return {
      metadata: {
        version: 1,
        scope: input.scope,
        role: "user",
        contentHash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
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
