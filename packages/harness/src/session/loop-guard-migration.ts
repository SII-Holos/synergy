import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { UpgradeWork } from "../storage/upgrade-work"
import { MessageV2 } from "./message-v2"
import { SessionHistoryDisplay } from "./history-display"
import { SessionMessageCache } from "./message-cache"
import { SessionSearchIndex } from "./search-index"

export async function migrateLoopGuardNotices(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  let done = 0
  for await (const { key, value } of Storage.records<Record<string, unknown>>({ kind: "part", ...owner })) {
    await UpgradeWork.checkpoint()
    progress(++done, 0)
    if (value.type !== "text" || typeof value.text !== "string") continue
    if (
      !/^\[(Tool repeat loop detected|Tool error loop detected|Search failure reflection|Search early stop)\]/.test(
        value.text,
      )
    )
      continue
    const part = MessageV2.TextPart.parse(value)
    if (!MessageV2.isSystemPart(part)) continue
    const scopeID = Identifier.asScopeID(owner.scopeID)
    const sessionID = Identifier.asSessionID(owner.sessionID)
    const messageID = Identifier.asMessageID(part.messageID)
    const [message] = await Storage.readMany<MessageV2.Info>([StoragePath.messageInfo(scopeID, sessionID, messageID)])
    if (message?.role !== "user") continue
    await Storage.transaction(async () => {
      await Storage.remove(key)
      await SessionHistoryDisplay.partRemoved(scopeID, sessionID, messageID, part.id)
      await SessionSearchIndex.markDirty(scopeID, sessionID)
      SessionMessageCache.invalidate(sessionID)
    })
  }
  progress(done, done)
}
