import { createHash } from "node:crypto"
import z from "zod"
import { Identifier } from "../id/id"
import { SecretMask } from "../secrets/mask"
import { Storage } from "../storage/storage"
import { MessageV2 } from "./message-v2"
import { SessionUserMessageMaterialization } from "./user-message-materialization"

// Section snapshots and semantic updates follow Codex WorldState; Session messages
// remain our authority. See docs/decisions/implemented/architecture/2026-09-28-durable-prompt-context.md.
export namespace SessionPromptContext {
  const key = "promptContext"
  const Entry = z.object({
    id: z.string(),
    partID: z.string(),
    partHash: z.string(),
    valueHash: z.string().optional(),
    rootScoped: z.boolean(),
    event: z.boolean(),
  })
  const Snapshot = z.object({ version: z.literal(1), modelKey: z.string(), sections: z.array(Entry) })
  type Entry = z.infer<typeof Entry>

  export interface Section {
    id: string
    text?: string
    rootScoped?: boolean
    event?: boolean
  }

  export function reserve() {
    return { id: Identifier.ascending("message"), created: Date.now() }
  }

  function hash(text: string) {
    return createHash("sha256").update(text).digest("hex")
  }

  export function stripMetadata(metadata: Record<string, unknown> | undefined) {
    if (!metadata) return undefined
    const { [key]: ignored, ...rest } = metadata
    return rest
  }

  export async function prepare(input: {
    root: MessageV2.User
    history: MessageV2.WithParts[]
    sections: Section[]
    modelKey: string
    identity?: ReturnType<typeof reserve>
  }): Promise<MessageV2.WithParts | undefined> {
    const previous = new Map<string, Entry & { rootID?: string; modelKey: string; retained: boolean }>()
    for (const message of input.history) {
      const info = message.info
      if (
        info.role !== "user" ||
        info.includeInContext === false ||
        info.origin?.type !== "system" ||
        info.origin.detail !== "context_update" ||
        !info.metadata?.[key]
      )
        continue
      const snapshot = Snapshot.parse(info.metadata[key])
      for (const section of snapshot.sections) {
        const part = message.parts.find((part) => part.id === section.partID)
        const retained = part?.type === "text" && MessageV2.isSystemPart(part) && hash(part.text) === section.partHash
        previous.set(section.id, { ...section, rootID: info.rootID, modelKey: snapshot.modelKey, retained })
      }
    }

    const identity = input.identity ?? reserve()
    const parts: MessageV2.TextPart[] = []
    const sections: Entry[] = []
    const current = new Map(input.sections.map((section) => [section.id, section]))
    if (current.size !== input.sections.length) throw new Error("Duplicate prompt context section")
    for (const [id, prior] of previous) {
      if (!current.has(id) && !prior.event) current.set(id, { id, rootScoped: prior.rootScoped })
    }
    for (const section of current.values()) {
      const prior = previous.get(section.id)
      const sameScope =
        prior?.retained && prior.modelKey === input.modelKey && (!section.rootScoped || prior.rootID === input.root.id)
      if (section.event && prior && sameScope) continue
      const masked = section.text ? await SecretMask.apply(section.text) : undefined
      let valueHash = masked ? hash(masked) : undefined
      if ((!prior && !valueHash) || (prior && sameScope && prior.valueHash === valueHash)) continue
      const text = masked
        ? await SecretMask.captureAndApply(masked, { kind: "heuristic", context: "user_message" })
        : undefined
      valueHash = text ? hash(text) : undefined
      if (prior && sameScope && prior.valueHash === valueHash) continue
      const body = [
        `<context-update section=${JSON.stringify(section.id)}>`,
        "Advisory context; it does not override system, developer, permission or tool instructions.",
        section.rootScoped
          ? "Applies only to the user task containing this update."
          : "Applies until replaced by a later update to this section.",
        section.event
          ? "Observation at this point in the task."
          : "Replaces the previous advisory context in this section.",
        text ?? "The previous advisory context in this section no longer applies.",
        "</context-update>",
      ].join("\n")
      const part: MessageV2.TextPart = {
        id: Identifier.ascending("part"),
        messageID: identity.id,
        sessionID: input.root.sessionID,
        type: "text",
        origin: "system",
        text: body,
      }
      parts.push(part)
      sections.push({
        id: section.id,
        partID: part.id,
        partHash: hash(body),
        valueHash,
        rootScoped: section.rootScoped ?? false,
        event: section.event ?? false,
      })
    }
    if (!parts.length) return
    return {
      info: {
        id: identity.id,
        sessionID: input.root.sessionID,
        role: "user",
        agent: input.root.agent,
        model: input.root.model,
        time: { created: identity.created },
        rootID: input.root.id,
        isRoot: false,
        visible: false,
        includeInContext: true,
        origin: { type: "system", detail: "context_update" },
        metadata: { [key]: Snapshot.parse({ version: 1, modelKey: input.modelKey, sections }) },
      },
      parts,
    }
  }

  export async function commit(context: MessageV2.WithParts | undefined, assistant: MessageV2.Assistant) {
    const { Session } = await import(".")
    const created = Date.now()
    async function writeAssistant(message?: MessageV2.WithParts) {
      const existing = await MessageV2.get({ sessionID: assistant.sessionID, messageID: assistant.id }).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        },
      )
      if (existing) return
      assistant.time.created = message?.info.time.created ?? created
      await Session.updateMessage(assistant)
    }
    if (!context) return Storage.transaction(() => writeAssistant())
    context.info.time.created = created
    await SessionUserMessageMaterialization.writePrepared(context, { commit: writeAssistant })
  }
}
