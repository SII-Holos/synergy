import { Storage } from "../storage/storage"
import { SessionPluginHooks } from "./plugin-hooks"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { SecretMask } from "../secrets/mask"

const log = Log.create({ service: "session.user-message-materialization" })

function observerInput(message: MessageV2.WithParts) {
  const derived = MessageV2.deriveSemantics([message])[0]
  if (!derived || derived.info.role !== "user") return
  if (derived.parts.some((part) => part.type === "compaction" || part.type === "compaction_recovery")) return
  const text = derived.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !MessageV2.isSystemPart(part))
    .map((part) => part.text)
    .join("\n")
    .trim()
  if (!text) return
  const origin = derived.info.origin?.type
  if (origin !== "user" && origin !== "channel" && origin !== "agenda") return
  return {
    message: {
      id: derived.info.id,
      text,
      createdAt: derived.info.time.created,
    },
  }
}

export namespace SessionUserMessageMaterialization {
  export interface CommitOptions {
    commit?(message: MessageV2.WithParts): Promise<void>
  }
  export const input = observerInput
  export async function write<Info extends MessageV2.Info>(
    message: {
      info: Info
      parts: MessageV2.Part[]
    },
    options: CommitOptions = {},
  ): Promise<{ info: Info; parts: MessageV2.Part[] }> {
    const { Session } = await import(".")
    const prepared: MessageV2.Part[] = []
    for (const part of message.parts) {
      const normalized = await Session.preparePart(part)
      // Ingress masking: a pasted secret persists as its stable token so the
      // durable record never holds the plaintext.
      prepared.push(await SecretMask.maskPart(normalized))
    }
    return Storage.transaction(async () => {
      const existing = await MessageV2.get({ sessionID: message.info.sessionID, messageID: message.info.id }).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        },
      )
      if (existing) {
        await options.commit?.(existing)
        return existing as { info: Info; parts: MessageV2.Part[] }
      }
      const info = (await Session.updateMessage(message.info)) as Info
      const parts = []
      for (const part of prepared) parts.push(await Session.updatePart(part))
      const result = { info, parts }
      await options.commit?.(result)
      Storage.afterCommit(() => after(result))
      return result
    })
  }

  export function after(message: MessageV2.WithParts) {
    const input = observerInput(message)
    if (!input) return
    void SessionPluginHooks.trigger(
      "session.user-message.after",
      input,
      {},
      { sessionId: message.info.sessionID },
    ).catch(() => {
      log.error("user message observer dispatch failed", {
        messageID: message.info.id,
        status: "failed",
      })
    })
  }
}
