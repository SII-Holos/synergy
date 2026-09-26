import { Storage } from "../storage/storage"
import type { MessageV2 } from "./message-v2"

export namespace SnapshotEvidence {
  export function interrupt(part: MessageV2.Part): MessageV2.Part {
    if (part.type !== "patch" || part.operation?.status !== "pending") return part
    return { ...part, operation: { ...part.operation, status: "incomplete" } }
  }

  export async function recover(
    owner: { scopeID: string; sessionID: string },
    messages: string[],
    progress?: () => void,
  ) {
    let changed = false
    for (const messageID of new Set(messages)) {
      for await (const record of Storage.records<MessageV2.Part>({
        kind: "part",
        scopeID: owner.scopeID,
        sessionID: owner.sessionID,
        messageID,
      })) {
        const part = record.value
        if (part.type === "patch" && part.operation?.status === "pending") {
          await Storage.transaction(async () => {
            const current = await Storage.read<MessageV2.Part>(record.key)
            const next = interrupt(current)
            if (next !== current) {
              await Storage.write(record.key, next)
              changed = true
            }
          })
        }
        progress?.()
      }
    }
    if (changed) {
      const { SessionMessageCache } = await import("./message-cache")
      SessionMessageCache.invalidate(owner.sessionID)
    }
  }
}
