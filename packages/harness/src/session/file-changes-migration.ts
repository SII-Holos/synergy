import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { MessageV2 } from "./message-v2"
import { SnapshotRanges } from "./snapshot-ranges"
import { SessionHistoryDisplay } from "./history-display"

export async function migrateTurnFileCheckpoints(owner: { scopeID: string; sessionID: string }) {
  const scopeID = Identifier.asScopeID(owner.scopeID)
  const sessionID = Identifier.asSessionID(owner.sessionID)
  const messages: MessageV2.WithParts[] = []
  const byID = new Map<string, MessageV2.WithParts>()
  for await (const { value: info } of Storage.records<MessageV2.Info>({ kind: "message", scopeID, sessionID })) {
    const message = { info, parts: [] as MessageV2.Part[] }
    messages.push(message)
    byID.set(info.id, message)
  }
  for await (const { value: part } of Storage.records<MessageV2.Part>({ kind: "part", scopeID, sessionID }))
    byID.get(part.messageID)?.parts.push(part)
  for (const message of messages) message.parts.sort((a, b) => a.id.localeCompare(b.id))
  messages.sort((a, b) => a.info.id.localeCompare(b.info.id))
  const canonical = MessageV2.deriveSemantics(messages)
  const roots = canonical.filter((message) => message.info.role === "user" && message.info.isRoot)
  let changed = false
  await Storage.transaction(async () => {
    for (const root of roots) {
      const turn = canonical.filter(
        (message) => message.info.id === root.info.id || message.info.rootID === root.info.id,
      )
      const ranges = SnapshotRanges.net(SnapshotRanges.fromMessages(turn))
      if (root.info.role === "user") {
        for (const diff of root.info.summary?.diffs ?? []) {
          if (ranges.some((range) => SnapshotRanges.key(range) === SnapshotRanges.key(diff))) continue
          if (!diff.workspace && !diff.legacyRoot && ranges.some((range) => range.files.includes(diff.file))) continue
          ranges.push({
            workspace: diff.workspace,
            legacyRoot: diff.legacyRoot,
            files: [],
            incomplete: true,
            issue: "legacy_range",
          })
        }
      }
      for (const range of ranges) {
        if (range.checkpointID) continue
        const part: MessageV2.PatchPart = {
          id: Identifier.ascending("part"),
          sessionID: owner.sessionID,
          messageID: root.info.id,
          type: "patch",
          hash: range.from ?? "",
          workspace: range.workspace,
          files: range.files,
          checkpoint: {
            version: 1,
            rootID: root.info.id,
            segmentID: `legacy:${root.info.id}`,
            started: root.info.time.created,
            status: "incomplete",
            afterHash: range.to,
            error: "legacy_range",
          },
        }
        await Storage.write(
          StoragePath.messagePart(
            scopeID,
            sessionID,
            Identifier.asMessageID(root.info.id),
            Identifier.asPartID(part.id),
          ),
          part,
        )
        root.parts.push(part)
        await SessionHistoryDisplay.partWritten(scopeID, part)
        changed = true
      }
      if (root.info.role !== "user" || !root.info.summary || !ranges.some((range) => !range.checkpointID)) continue
      root.info.summary.diffState = { status: root.info.summary.diffs.length ? "partial" : "error", code: "incomplete" }
      root.info.summary.diffIssues = ranges.map((range) => ({ workspace: range.workspace, code: "legacy_range" }))
      await Storage.write(StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(root.info.id)), root.info)
      await SessionHistoryDisplay.messageWritten(scopeID, root.info)
    }
    await Storage.write(StoragePath.sessionSummaryCursor(scopeID, sessionID), {
      version: 4,
      ranges: SnapshotRanges.fromMessages(canonical),
    })
    if (changed) {
      const key = StoragePath.sessionInfo(scopeID, sessionID)
      const info = await Storage.read<{ summary?: { files: number; diffState?: unknown; diffIssues?: unknown } }>(key)
      if (info.summary) {
        info.summary.diffState = { status: info.summary.files ? "partial" : "error", code: "incomplete" }
        info.summary.diffIssues = [{ code: "legacy_range" }]
        await Storage.write(key, info)
      }
    }
  })
}
