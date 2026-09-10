import type { Migration } from "../../migration/types"
import { Identifier } from "../../id/id"
import { StoragePath } from "../../storage/path"
import { Storage } from "../../storage/storage"
import { MessageV2 } from "../message-v2"
import { SessionHistory } from "../history"
import { SessionProgress } from "../progress"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"

export namespace RolloutContinuationMigration {
  export async function session(owner: RolloutSchema.Owner) {
    if (owner.kind !== "session") return
    const root = [...RolloutArtifact.root(owner), "runs"]
    const candidates: RolloutSchema.RunRecord[] = []
    for (const id of await Storage.scan(root, { strict: true })) {
      const run = await RolloutLedger.getRun(owner, id)
      if (run.status === "completed" && run.recording !== "failed" && !run.cancelRequestedAt) candidates.push(run)
    }
    if (!candidates.length) return
    const scopeID = Identifier.asScopeID(owner.scopeID)
    const sessionID = Identifier.asSessionID(owner.sessionID)
    const history = StoragePath.sessionHistoryRoot(scopeID, sessionID)
    const [infos, eventIDs] = await Promise.all([
      MessageV2.readInfoList({ scopeID, sessionID }),
      Storage.scan(history, { strict: true }),
    ])
    const events = await Promise.all(eventIDs.sort().map((id) => Storage.read<SessionHistory.Event>([...history, id])))
    const messages = SessionHistory.applyEvents(
      MessageV2.deriveSemantics(infos.map((info) => ({ info, parts: [] }))),
      events,
    )
    for (const run of candidates) {
      if (!SessionProgress.needsModelCall(messages, run.id)) continue
      await RolloutJournal.write(owner, [...root, run.id, "info"], { ...run, status: "interrupted" })
    }
  }

  export const migration: Migration = {
    id: "20260910-rollout-unanswered-continuation",
    description: "Recover prematurely completed rollouts with unanswered continuation messages",
    dependsOn: ["20260907-session-rollout-evidence"],
    async up(progress) {
      progress(0, 0)
      const owners: RolloutSchema.Owner[] = []
      for (const scopeID of await Storage.scan(["sessions"], { strict: true }))
        for (const sessionID of await Storage.scan(["sessions", scopeID], { strict: true }))
          owners.push({ kind: "session", scopeID, sessionID })
      progress(0, owners.length)
      for (const [index, owner] of owners.entries()) {
        await session(owner)
        progress(index + 1, owners.length)
      }
    },
  }
}
