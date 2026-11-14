import { Storage } from "../storage/storage"
import type { MessageV2 } from "./message-v2"

export namespace SnapshotEvidence {
  export function portable(info: MessageV2.Info): MessageV2.Info
  export function portable(info: unknown): unknown
  export function portable(info: unknown): unknown {
    if (!info || typeof info !== "object" || Array.isArray(info)) return info
    const record = info as Record<string, unknown>
    if (
      record.role !== "user" ||
      !record.summary ||
      typeof record.summary !== "object" ||
      Array.isArray(record.summary)
    )
      return info
    const summary = record.summary as Record<string, unknown>
    if (!summary.diffRevision) return info
    return {
      ...record,
      summary: {
        ...summary,
        diffs: [],
        diffRevision: undefined,
        diffTotals: undefined,
        diffObservedAt: undefined,
        diffHasChanges: undefined,
        diffState: { status: "error", code: "incomplete" },
      },
    }
  }

  export function interrupt(part: MessageV2.Part): MessageV2.Part {
    if (part.type === "patch" && part.checkpoint?.status === "pending")
      return { ...part, checkpoint: { ...part.checkpoint, status: "incomplete", error: "interrupted" } }
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
        if (part.type === "patch" && (part.operation?.status === "pending" || part.checkpoint?.status === "pending")) {
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
