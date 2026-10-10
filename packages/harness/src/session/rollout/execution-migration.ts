import type { Migration } from "../../migration/types"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { Identifier } from "../../id/id"
import { MessageV2 } from "../message-v2"
import { SessionProgress } from "../progress"
import { RolloutArtifact } from "./artifact"
import { RolloutJournal } from "./journal"
import { RolloutSnapshot } from "./snapshot"
import { RolloutExecution } from "./execution"
import { RolloutSchema } from "./schema"
import { UpgradeWork } from "../../storage/upgrade-work"
import { upgradeAccessRecord } from "../../migration/import"

export namespace RolloutExecutionMigration {
  export async function owner(owner: RolloutSchema.Owner, messages?: MessageV2.WithParts[]) {
    const root = RolloutArtifact.root(owner)
    let canonical: MessageV2.WithParts[] | undefined
    for (const runID of await Storage.scan([...root, "runs"])) {
      UpgradeWork.signal()?.throwIfAborted()
      const run = RolloutSchema.RunRecord.parse(await Storage.read([...root, "runs", runID, "info"]))
      if (run.timingVersion === 1) continue
      const snapshot = await RolloutSnapshot.projected(owner, run.id)
      if (!messages && owner.kind === "session") {
        const scopeID = Identifier.asScopeID(owner.scopeID)
        const sessionID = Identifier.asSessionID(owner.sessionID)
        const ids = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sessionID))
        const keys = ids.map((id) => StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(id)))
        const records = await Storage.readMany(keys)
        messages = records.flatMap((value, index) => {
          const info = MessageV2.Info.safeParse(upgradeAccessRecord(keys[index]!, value))
          return info.success ? [{ info: info.data, parts: [] }] : []
        })
      }
      canonical ??= MessageV2.deriveSemantics(
        (messages ?? []).toSorted(
          (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
        ),
      )
      const segments = snapshot.segments.filter((segment) => segment.runID === run.id)
      const calls = snapshot.calls.filter((call) => call.runID === run.id)
      const intervals = snapshot.intervals.filter((interval) => interval.runID === run.id)
      const response = canonical.some((message) => message.info.role === "assistant" && message.info.rootID === run.id)
      const terminal = SessionProgress.findTerminalReply(canonical, run.id)
      const admissionOnly =
        !response &&
        !run.input &&
        !segments.length &&
        !calls.length &&
        !snapshot.tools.some((tool) => tool.runID === run.id)
      for (const segment of segments) {
        if (intervals.some((interval) => interval.segmentID === segment.id)) continue
        const attempts = snapshot.attempts.filter(
          (attempt) =>
            attempt.runID === run.id &&
            calls.some(
              (call) =>
                call.id === attempt.callID && (call.usageRole === "conversation" || call.usageRole === "compaction"),
            ) &&
            attempt.started >= segment.started &&
            (segment.ended === undefined || attempt.started <= segment.ended),
        )
        const evidence = attempts.flatMap((attempt) => {
          const timing = attempt.timing
          if (
            timing?.sentAt === undefined ||
            timing.endedAt === undefined ||
            timing.requestMs === undefined ||
            timing.detectedAt !== undefined
          )
            return []
          if (Math.abs(timing.endedAt - timing.sentAt - timing.requestMs) > 2) return []
          const duration = Math.min(timing.requestMs, Math.max(0, timing.endedAt - timing.sentAt))
          return [{ id: attempt.id, started: timing.sentAt, ended: timing.sentAt + duration }]
        })
        for (const span of evidence.length
          ? evidence
          : [{ id: segment.id, started: segment.started, ended: segment.started }]) {
          await RolloutExecution.write({
            version: 1,
            id: span.id,
            owner,
            runID: run.id,
            segmentID: segment.id,
            branchID: "historical",
            clockID: "historical-wall-v1",
            started: Math.max(0, span.started),
            ended: Math.max(0, span.ended),
            status: "closed",
            coverage: "partial",
          })
        }
      }
      const last = segments.toSorted((a, b) => b.started - a.started || b.id.localeCompare(a.id))[0]
      await RolloutJournal.write(owner, [...root, "runs", run.id, "info"], {
        ...run,
        timingVersion: 1,
        ...(admissionOnly
          ? {
              admissionOnly: true,
              status: run.cancelRequestedAt ? "cancelled" : "interrupted",
              ended: undefined,
              detectedAt: Date.now(),
            }
          : last && last.status !== "running" && !run.execution
            ? { execution: { status: last.status, at: last.ended ?? last.started } }
            : terminal?.info.role === "assistant" && !run.execution
              ? {
                  execution: {
                    status: terminal.info.error ? "failed" : "completed",
                    at: terminal.info.time.completed ?? terminal.info.time.created,
                  },
                }
              : {}),
      })
    }
    await Storage.remove([...root, "snapshot-v1"])
  }

  export const migration: Migration = {
    id: "20261008-rollout-execution-time",
    emptyInput: [["sessions"], ["operations"]],
    scope: "session",
    execution: "owner",
    dependsOn: ["20261001-rollout-attempt-price-evidence"],
    description:
      "Separate execution intervals from input admission and retain confirmed historical time as a lower bound",
    async upOwner(identity) {
      await owner(identity)
    },
    async upSession(identity) {
      await owner({ kind: "session", ...identity })
    },
    async up(progress) {
      let count = 0
      for (const category of ["sessions", "operations"] as const)
        for (const scopeID of await Storage.scan([category]))
          for (const id of await Storage.scan([category, scopeID])) {
            await owner(
              category === "sessions"
                ? { kind: "session", scopeID, sessionID: id }
                : { kind: "operation", scopeID, operationID: id },
            )
            progress(++count, 0)
          }
      progress(count, count)
    },
  }
}
