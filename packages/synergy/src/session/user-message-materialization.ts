import { Plugin } from "@/plugin"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"

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
  export const input = observerInput
  export async function write<Info extends MessageV2.Info>(message: {
    info: Info
    parts: MessageV2.Part[]
  }): Promise<{ info: Info; parts: MessageV2.Part[] }> {
    const { Session } = await import(".")
    const info = (await Session.updateMessage(message.info)) as Info
    for (const part of message.parts) await Session.updatePart(part)
    after({ info, parts: message.parts })
    return { info, parts: message.parts }
  }

  export function after(message: MessageV2.WithParts) {
    const input = observerInput(message)
    if (!input) return
    void Plugin.trigger("session.user-message.after", input, {}, { sessionId: message.info.sessionID }).catch(() => {
      log.error("user message observer dispatch failed", {
        messageID: message.info.id,
        status: "failed",
      })
    })
  }
}
