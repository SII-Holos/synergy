import { Storage } from "../../storage/storage"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutLedger } from "./ledger"
import { RolloutSnapshot } from "./snapshot"
import type { RolloutSchema } from "./schema"
import { record } from "./error"
import { RolloutPending } from "./pending"

export namespace RolloutRecovery {
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
    return record(async () => {
      await RolloutJournal.recover(identity, onProgress)
      const snapshot = await RolloutSnapshot.read(identity, { onProgress })
      for (const segment of snapshot.segments) {
        if (segment.status === "running") await RolloutLedger.finishSegment(segment, "interrupted")
        onProgress?.()
      }
      for (const attempt of snapshot.attempts) {
        if (attempt.status !== "running") continue
        await RolloutLedger.writeAttempt({
          ...attempt,
          status: "interrupted",
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
      for (const run of snapshot.runs) {
        if (run.status === "running") await RolloutLedger.finishRun(identity, run.id, "interrupted")
        onProgress?.()
      }
    })
  }

  export async function* owners(onProgress?: () => void): AsyncGenerator<RolloutSchema.Owner> {
    for (const category of ["sessions", "operations"] as const) {
      for (const scopeID of await Storage.scan([category], { strict: true })) {
        for (const id of await Storage.scan([category, scopeID], { strict: true })) {
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

  /**
   * Recovers every owner that may hold unsettled work, then re-arms the
   * durable pending set. A valid pending set bounds the pass to its members;
   * a missing or malformed set falls back to the exhaustive scan because the
   * pending state cannot be trusted. Both paths require exclusive runtime
   * ownership.
   */
  export async function all(onProgress?: (current: number) => void) {
    let current = 0
    onProgress?.(current)
    const checked = () => onProgress?.(++current)
    const pending = await RolloutPending.tracked()
    // Settlement itself writes journals; suspend tracking so recovery never
    // consults (or fails closed on) the ledger it is about to re-arm.
    RolloutPending.suspendTracking()
    try {
      if (pending) {
        for (const identity of pending.owners) {
          await owner(identity, checked)
          checked()
        }
        if (pending.owners.length > 0) await RolloutPending.markClean()
        return
      }
      for await (const identity of owners(checked)) await owner(identity, checked)
      await RolloutPending.markClean()
    } finally {
      RolloutPending.resumeTracking()
    }
  }
}
