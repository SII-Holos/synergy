import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutQuery } from "@ericsanchezok/synergy-harness/session/rollout/query"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import type { MemberConnection } from "./connection"
import type { createCommandIntake } from "./command-intake"

type Intake = ReturnType<typeof createCommandIntake>

const log = Log.create({ service: "organization.execution-release" })

function outcome(status: "completed" | "failed" | "cancelled" | "interrupted" | "running") {
  if (status === "completed" || status === "failed" || status === "cancelled") return status
  throw new Error("Terminal release evidence has a non-terminal status")
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function startExecutionReleaseObserver(input: {
  connection: MemberConnection["connected"]
  intake: Intake
  resources: MemberConnection["resources"]
  signal: AbortSignal
}) {
  const pending = new Map<string, Promise<void>>()
  let stopped = false

  async function settle(entry: Awaited<ReturnType<Intake["releaseEntries"]>>[number]) {
    let delay = 100
    while (!stopped) {
      input.signal.throwIfAborted()
      try {
        await SessionManager.waitForIdle(entry.sessionID, input.signal)
        let evidence: Awaited<ReturnType<typeof RolloutQuery.releaseEvidence>>
        {
          using fence = await Lock.writeWithSignal(`organization-execution:${entry.sessionID}`, input.signal)
          evidence = await RolloutQuery.releaseEvidence(entry.sessionID, entry.rootID, input.signal)
          if (evidence) {
            const lookup = entry.actor
            const description = await input.intake.retentionProof({
              subjectID: lookup.subjectID,
              requestID: lookup.requestID,
            })
            const grant = await input.resources.retention(description, input.signal)
            if (grant.grantID !== entry.grantID) throw new Error("Execution release grant changed")
            const result = outcome(evidence.status)
            if (grant.state === "closed" || (grant.state === "bound" && grant.retention.state === "released")) {
              await input.intake.markRelease(entry)
              return
            }
            const generation = grant.state === "bound" ? grant.retention.generation : 0
            const proof = Execution.ReleaseProof.parse({
              ...description,
              purpose: "execution-resources-release",
              rootID: entry.rootID,
              generation,
              outcome: result,
              materialized: generation === 0,
            })
            const receipt = await input.resources.release(proof, input.signal)
            await input.intake.markRelease(entry, receipt)
            return
          }
        }
        if (!evidence) {
          await sleep(delay, input.signal)
          delay = Math.min(delay * 2, 5_000)
          continue
        }
      } catch (error) {
        input.signal.throwIfAborted()
        log.warn("execution release retry scheduled", { sessionID: entry.sessionID, rootID: entry.rootID, error })
        await sleep(delay, input.signal)
        delay = Math.min(delay * 2, 5_000)
      }
    }
  }

  function enqueue(sessionID?: string, rootID?: string) {
    if (stopped) return
    void input.intake
      .releaseEntries()
      .then((entries) => {
        for (const entry of entries) {
          if (sessionID && entry.sessionID !== sessionID) continue
          if (rootID && entry.rootID !== rootID) continue
          const key = `${entry.sessionID}:${entry.rootID}`
          if (pending.has(key)) continue
          const task = settle(entry).finally(() => pending.delete(key))
          pending.set(key, task)
        }
      })
      .catch((error) => {
        if (!input.signal.aborted) log.warn("execution release index scan failed", { error })
      })
  }

  const unsubscribe = Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
    const record = event.properties.record
    if (record.kind !== "run" || record.value.owner.kind !== "session") return
    if (!["completed", "failed", "cancelled"].includes(record.value.status)) return
    enqueue(record.value.owner.sessionID, record.value.id)
  })
  const stop = () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    for (const task of pending.values()) void task.catch(() => {})
  }
  input.signal.addEventListener("abort", stop, { once: true })
  enqueue()
  return stop
}
