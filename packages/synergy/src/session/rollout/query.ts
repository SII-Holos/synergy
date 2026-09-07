import z from "zod"
import { Session } from "../index"
import { RolloutSnapshot } from "./snapshot"
import { RolloutAccounting } from "./accounting"
import { RolloutSchema } from "./schema"
import { RolloutRecovery } from "./recovery"
import { RolloutLedger } from "./ledger"
import { Storage } from "@/storage/storage"
import { Experiment } from "@/config/experiment"

export namespace RolloutQuery {
  export const Result = z
    .object({
      version: z.literal(1),
      run: RolloutSchema.RunRecord,
      snapshots: z.array(RolloutSnapshot.Info),
      accounting: RolloutAccounting.Summary,
      elapsedMs: z.number().nonnegative(),
    })
    .strict()
    .meta({ ref: "RolloutResult" })
  export type Result = z.infer<typeof Result>

  export async function tree(owner: RolloutSchema.Owner, runID: string): Promise<Result> {
    const root = await RolloutSnapshot.read(owner, { runID })
    const run = root.runs.find((run) => run.id === runID)
    if (!run) throw new Error(`Run not found: ${runID}`)
    const snapshots = [root]
    const seen = new Set([`${JSON.stringify(owner)}:${runID}`])
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index]
      if (snapshot.owner.kind !== "session") continue
      for (const child of await Session.children(snapshot.owner.sessionID)) {
        const identity = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
        const recorded = await RolloutSnapshot.read(identity)
        for (const childRun of recorded.runs) {
          const parent = childRun.parent
          if (
            !parent?.runID ||
            parent.owner.kind !== "session" ||
            parent.owner.sessionID !== snapshot.owner.sessionID ||
            !snapshot.runs.some((run) => run.id === parent.runID)
          )
            continue
          const key = `${JSON.stringify(identity)}:${childRun.id}`
          if (seen.has(key)) continue
          seen.add(key)
          snapshots.push(await RolloutSnapshot.read(identity, { runID: childRun.id, revision: recorded.revision }))
        }
      }
    }
    return Result.parse({
      version: 1,
      run,
      snapshots,
      accounting: RolloutAccounting.merge(snapshots.map(RolloutAccounting.summarize)),
      elapsedMs: Math.max(0, (run.ended ?? Date.now()) - run.started),
    })
  }
  export async function find(runID: string) {
    let owner: RolloutSchema.Owner | undefined
    for await (const candidate of RolloutRecovery.owners()) {
      const run = await RolloutLedger.getRun(candidate, runID).catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
      if (!run) continue
      if (owner) throw new Error(`Run ID is ambiguous: ${runID}`)
      owner = candidate
    }
    if (!owner) throw new Error(`Run not found: ${runID}`)
    return tree(owner, runID)
  }
  export function compare(left: Result, right: Result) {
    const a = left.run.configuration?.effective ?? {}
    const b = right.run.configuration?.effective ?? {}
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (key) =>
        Experiment.fingerprint(Reflect.get(a, key) ?? null) !== Experiment.fingerprint(Reflect.get(b, key) ?? null),
    )
    return {
      version: 1 as const,
      changedConfiguration: changed,
      initialContext: "Review each run input and session history before interpreting differences" as const,
      runs: [left, right].map(({ run, accounting, elapsedMs }) => ({ run, accounting, elapsedMs })),
    }
  }
}
