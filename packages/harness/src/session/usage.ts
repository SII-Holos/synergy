import { MessageV2 } from "./message-v2"
import type { Info } from "./types"
import { RolloutAccounting } from "./rollout/accounting"
import { RolloutSnapshot } from "./rollout/snapshot"

export namespace SessionUsage {
  export async function read(session: Info) {
    const snapshot = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
    const recordedRoots = new Set(snapshot.runs.map((run) => run.id))
    const accounting = RolloutAccounting.summarize(snapshot)
    const result = RolloutAccounting.project(accounting)
    for await (const message of MessageV2.stream({ scopeID: session.scope.id, sessionID: session.id })) {
      const info = message.info
      if (info.role !== "assistant") continue
      if (
        info.accounting?.kind === "inherited" ||
        info.accounting?.kind === "imported" ||
        info.accounting?.kind === "rollout" ||
        recordedRoots.has(info.rootID ?? info.parentID)
      )
        continue
      result.tokens.input += info.tokens.input
      result.tokens.output += info.tokens.output
      result.tokens.reasoning += info.tokens.reasoning
      result.tokens.cache.read += info.tokens.cache.read
      result.tokens.cache.write += info.tokens.cache.write
      result.cost += info.cost
      accounting.legacy.cost += info.cost
      accounting.legacy.messages++
    }
    return { ...result, accounting }
  }
}
