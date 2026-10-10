import { RolloutExecution } from "./execution"
import { Storage } from "../../storage/storage"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutLedger } from "./ledger"
import { RolloutSnapshot } from "./snapshot"
import type { RolloutSchema } from "./schema"
import { record } from "./error"
import { RolloutPending } from "./pending"
import { SnapshotEvidence } from "../snapshot-evidence"
import { RuntimeContext } from "../../lifecycle/context"
import { UpgradeWork } from "../../storage/upgrade-work"

export namespace RolloutRecovery {
  const admission = Storage.state(() => ({
    enabled: false,
    ready: new Set<string>(),
    pending: new Map<string, Promise<void>>(),
  }))
  const recovering = RuntimeContext.createAsyncContext<{
    runtime: RuntimeContext.Instance
    store: object
    key: string
  }>()
  const identityKey = (identity: RolloutSchema.Owner) => JSON.stringify(RolloutArtifact.root(identity))

  export async function ensure(identity: RolloutSchema.Owner) {
    const state = admission()
    const key = identityKey(identity)
    const context = recovering.getStore()
    if (
      !state.enabled ||
      state.ready.has(key) ||
      (context?.runtime === RuntimeContext.current() &&
        context.store === Storage.current().store &&
        context.key === key)
    )
      return
    if (Storage.inTransaction()) throw new Error("Recover historical owners before opening a transaction")
    const pending = state.pending.get(key)
    if (pending) return pending
    const task = (async () => {
      if (await RolloutPending.needsRecovery(identity)) {
        await owner(identity, () => UpgradeWork.signal()?.throwIfAborted())
        await RolloutPending.recovered(identity)
      }
      state.ready.add(key)
    })().finally(() => state.pending.delete(key))
    state.pending.set(key, task)
    return task
  }
  async function committed(
    identity: RolloutSchema.Owner,
    ref: RolloutSchema.ArtifactRef | undefined,
    onProgress?: () => void,
  ) {
    if (!ref) return undefined
    const current = await RolloutArtifact.get(identity, ref.id)
    for await (const _ of RolloutArtifact.read(identity, current)) {
      onProgress?.()
    }
    return current
  }

  /** Requires exclusive runtime ownership; never invoke against a live writer. */
  export async function owner(identity: RolloutSchema.Owner, onProgress?: () => void) {
    return recovering.run(
      { runtime: RuntimeContext.current(), store: Storage.current().store, key: identityKey(identity) },
      () =>
        record(async () => {
          await RolloutJournal.recover(identity, onProgress)
          const snapshot = await RolloutSnapshot.read(identity, { onProgress })
          for (const interval of snapshot.intervals) {
            await RolloutExecution.recover(interval)
            onProgress?.()
          }
          for (const segment of snapshot.segments) {
            if (segment.status === "running")
              await RolloutLedger.finishSegment(segment, "interrupted", { detectedAt: Date.now() })
            onProgress?.()
          }
          for (const attempt of snapshot.attempts) {
            if (attempt.status !== "running") continue
            await RolloutLedger.writeAttempt({
              ...attempt,
              status: "interrupted",
              ...(attempt.timing ? { timing: { ...attempt.timing, detectedAt: Date.now() } } : {}),
              ended: Date.now(),
              request: (await committed(identity, attempt.request, onProgress))!,
              response: await committed(identity, attempt.response, onProgress),
            })
            onProgress?.()
          }
          for (const call of snapshot.calls) {
            if (call.status !== "running") continue
            await RolloutLedger.finishCall(identity, call.runID, call.id, {
              status: "interrupted",
              response: await committed(identity, call.response, onProgress),
              error: "Runtime ended before call completion",
            })
            onProgress?.()
          }
          for (const tool of snapshot.tools) {
            if (tool.status !== "running") continue
            await RolloutLedger.writeTool({
              ...tool,
              status: "interrupted",
              ended: Date.now(),
              rawResult: await committed(identity, tool.rawResult, onProgress),
              observation: await committed(identity, tool.observation, onProgress),
              error: "Runtime ended; external side-effect completion is unknown. Recovery does not replay this tool.",
            })
            onProgress?.()
          }
          for (const process of snapshot.processes) {
            if (process.status !== "running") continue
            await RolloutLedger.writeProcess({
              ...process,
              status: "interrupted",
              ended: Date.now(),
              stream: (await committed(identity, process.stream, onProgress))!,
            })
            onProgress?.()
          }
          if (identity.kind === "session")
            await SnapshotEvidence.recover(
              identity,
              [...snapshot.tools.map((tool) => tool.messageID), ...snapshot.runs.map((run) => run.id)],
              onProgress,
            )
          for (const run of snapshot.runs) {
            if (run.status === "running")
              await RolloutLedger.finishRun(identity, run.id, "interrupted", { detectedAt: Date.now() })
            onProgress?.()
          }
        }),
    )
  }

  export async function* owners(onProgress?: () => void): AsyncGenerator<RolloutSchema.Owner> {
    for (const category of ["sessions", "operations"] as const) {
      for (const scopeID of await Storage.scan([category])) {
        for (const id of await Storage.scan([category, scopeID])) {
          const identity: RolloutSchema.Owner =
            category === "sessions"
              ? { kind: "session", scopeID, sessionID: id }
              : { kind: "operation", scopeID, operationID: id }
          const head = await RolloutJournal.head(identity)
          onProgress?.()
          if (head.allocated > 0) yield identity
        }
      }
    }
  }

  /** Startup establishes coverage; every historical owner is fenced before first access. */
  export async function all(onProgress?: (current: number) => void) {
    onProgress?.(0)
    const state = admission()
    state.enabled = false
    state.ready.clear()
    RolloutPending.resetTouched()
    if (!(await RolloutPending.tracked())) await RolloutPending.defer()
    state.enabled = true
  }

  /** After draining, settle this Runtime's writers and preserve untouched historical pending owners. */
  export async function settle() {
    const pending = await RolloutPending.tracked()
    if (!pending || pending.owners.length === 0) return
    RolloutPending.suspendTracking()
    try {
      const touched = new Set(RolloutPending.touched().map(identityKey))
      for (const identity of pending.owners) {
        if (!touched.has(identityKey(identity))) continue
        await owner(identity)
        await RolloutPending.recovered(identity)
      }
    } finally {
      RolloutPending.resumeTracking()
    }
  }
}
