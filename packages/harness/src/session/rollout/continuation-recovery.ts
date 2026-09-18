import { Identifier } from "../../id/id"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { Log } from "../../util/log"
import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"

export namespace RolloutContinuationRecovery {
  const log = Log.create({ service: "session.rollout.continuation-recovery" })
  const root = (owner: RolloutSchema.Owner) => {
    if (owner.kind !== "session") throw new Error("Only sessions can resume a continuation")
    return [
      ...StoragePath.sessionRoot(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID)),
      "continuation-recovery",
    ]
  }

  export async function request(owner: RolloutSchema.Owner, runID: string) {
    await Storage.write([...root(owner), runID], { runID })
  }

  export async function pending(sessionID: string): Promise<boolean> {
    const { SessionManager } = await import("../manager")
    const session = await SessionManager.getSession(sessionID)
    if (!session?.scope || session.time.archived) return false
    const owner = { kind: "session", scopeID: session.scope.id, sessionID } as const
    const ids = await Storage.scan(root(owner))
    if (!ids.length) return false
    const [{ SessionHistory }, { SessionProgress }] = await Promise.all([import("../history"), import("../progress")])
    if ((await SessionHistory.storedInfo(sessionID))?.rollback?.canUnrollback) return false
    const messages = await SessionHistory.detachedModelMessages({ sessionID })
    const latestRoot = messages.findLast((message) => message.info.role === "user" && message.info.isRoot)
    let pending = false
    for (const id of ids) {
      const run = await RolloutLedger.getRun(owner, id)
      if (
        id === latestRoot?.info.id &&
        (run.status === "interrupted" || run.status === "running") &&
        run.recording !== "failed" &&
        !run.cancelRequestedAt &&
        SessionProgress.needsModelCall(messages, id)
      ) {
        pending = true
        continue
      }
      await Storage.remove([...root(owner), id])
    }
    return pending
  }

  export async function list(scopeID?: string): Promise<string[]> {
    const candidates = new Set<string>()
    for await (const { key } of Storage.records({ kind: "continuation-recovery", scopeID })) candidates.add(key[2])
    const result: string[] = []
    for (const sessionID of candidates) {
      try {
        if (await pending(sessionID)) result.push(sessionID)
      } catch (error) {
        log.warn("continuation recovery discovery failed", { sessionID, error })
      }
    }
    return result.sort()
  }
}
