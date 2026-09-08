import { Storage } from "../../storage/storage"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutLedger } from "./ledger"
import { RolloutSnapshot } from "./snapshot"
import type { RolloutSchema } from "./schema"
import { record } from "./error"

export namespace RolloutRecovery {
  async function committed(identity: RolloutSchema.Owner, ref: RolloutSchema.ArtifactRef | undefined) {
    if (!ref) return undefined
    const current = await RolloutArtifact.get(identity, ref.id)
    for await (const _ of RolloutArtifact.read(identity, current)) {
      /* Validate the committed prefix without retaining payloads. */
    }
    return current
  }

  /** Requires exclusive runtime ownership; never invoke against a live writer. */
  export async function owner(identity: RolloutSchema.Owner) {
    return record(async () => {
      await RolloutJournal.recover(identity)
      const snapshot = await RolloutSnapshot.read(identity)
      for (const segment of snapshot.segments) {
        if (segment.status === "running") await RolloutLedger.finishSegment(segment, "interrupted")
      }
      for (const attempt of snapshot.attempts) {
        if (attempt.status !== "running") continue
        await RolloutLedger.writeAttempt({
          ...attempt,
          status: "interrupted",
          ended: Date.now(),
          request: (await committed(identity, attempt.request))!,
          response: await committed(identity, attempt.response),
        })
      }
      for (const call of snapshot.calls) {
        if (call.status !== "running") continue
        await RolloutLedger.finishCall(identity, call.runID, call.id, {
          status: "interrupted",
          response: await committed(identity, call.response),
          error: "Runtime ended before call completion",
        })
      }
      for (const tool of snapshot.tools) {
        if (tool.status !== "running") continue
        await RolloutLedger.writeTool({
          ...tool,
          status: "interrupted",
          ended: Date.now(),
          rawResult: await committed(identity, tool.rawResult),
          observation: await committed(identity, tool.observation),
          error: "Runtime ended; external side-effect completion is unknown. Recovery does not replay this tool.",
        })
      }
      for (const process of snapshot.processes) {
        if (process.status !== "running") continue
        await RolloutLedger.writeProcess({
          ...process,
          status: "interrupted",
          ended: Date.now(),
          stream: (await committed(identity, process.stream))!,
        })
      }
      for (const run of snapshot.runs) {
        if (run.status === "running") await RolloutLedger.finishRun(identity, run.id, "interrupted")
      }
    })
  }

  export async function* owners(): AsyncGenerator<RolloutSchema.Owner> {
    for (const category of ["sessions", "operations"] as const) {
      for (const scopeID of await Storage.scan([category], { strict: true })) {
        for (const id of await Storage.scan([category, scopeID], { strict: true })) {
          const identity: RolloutSchema.Owner =
            category === "sessions"
              ? { kind: "session", scopeID, sessionID: id }
              : { kind: "operation", scopeID, operationID: id }
          if ((await RolloutJournal.head(identity)).allocated > 0) yield identity
        }
      }
    }
  }

  export async function all() {
    for await (const identity of owners()) await owner(identity)
  }
}
