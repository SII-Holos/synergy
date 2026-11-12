import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutQuery } from "@ericsanchezok/synergy-harness/session/rollout/query"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import type { MemberConnection } from "./connection"
import type { createCommandIntake } from "./command-intake"
import { OrganizationExecutionLeases as Leases } from "./execution-leases"
import { OrganizationCommandRecords as Records } from "./command-records"
import { OrganizationIntakePath as Keys } from "./storage/path"

type Intake = ReturnType<typeof createCommandIntake>
const log = Log.create({ service: "organization.execution-release" })

export function startExecutionReleaseObserver(input: {
  connection: MemberConnection["connected"]
  intake: Intake
  resources: MemberConnection["resources"]
  signal: AbortSignal
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let current: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let scanFailure: { partition: string; error: unknown } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  type Target = { sessionID: string; rootID: string }
  const ready = new Map<string, Target>()
  const retry = new Map<string, Target>()
  let full = true
  let retryFull = false
  function enqueue(queue: Map<string, Target>, target: Target) {
    const key = JSON.stringify([target.sessionID, target.rootID])
    if (queue.has(key) || queue.size < 64) {
      queue.set(key, target)
      return true
    }
    return false
  }
  let stopped = false

  async function settleOriginal(entry: Leases.Entry, receipt: Execution.ReleaseReceipt) {
    const authority = entry.authority
    const [raw] = await Storage.readMany([
      Keys.release(authority.orgID, authority.input.subjectID, authority.input.requestID),
    ])
    if (raw === undefined) return
    const original = Records.Release.parse(raw)
    if (
      original.state === "pending" &&
      original.grantID === receipt.grantID &&
      original.rootID === receipt.rootID &&
      original.runtimeID === receipt.runtimeID &&
      original.bindingEpoch === receipt.bindingEpoch
    )
      await input.intake.markRelease(original, receipt)
  }
  async function settle(entry: Leases.Entry) {
    signal.throwIfAborted()
    if (entry.uncertainUntil !== undefined && entry.uncertainUntil > Date.now()) return true
    using fence = await Lock.tryAcquireWrite(`organization-execution:${entry.authority.sessionID}`)
    if (!fence) return true
    signal.throwIfAborted()
    if (SessionManager.isRunning(entry.authority.sessionID)) {
      const run = await RolloutLedger.getRun(
        { kind: "session", scopeID: entry.authority.projectID, sessionID: entry.authority.sessionID },
        entry.authority.rootID,
      )
      return ["completed", "failed", "cancelled"].includes(run.status)
    }
    const proof = await input.intake.cleanupProof(entry.authority, entry.hint)
    const inspected = await input.resources.inspectRetention(proof, signal)
    signal.throwIfAborted()
    if (inspected.state === "absent") {
      await Leases.settle(entry, {
        kind: "absent",
        controlAdmissionID: inspected.controlAdmissionID!,
        inspectedAt: inspected.inspectedAt,
      })
      return
    }
    if (inspected.release) {
      await Leases.settle(entry, { kind: "terminal", receipt: inspected.release })
      await settleOriginal(entry, inspected.release)
      return
    }
    const grant = inspected.grant
    const observed = await Leases.observe(entry, grant, inspected.inspectedAt)
    if (observed.entryID !== entry.entryID || observed.state !== "pending") return
    if (
      grant.state === "closed" ||
      (grant.state === "bound" && ["handoff_closed", "control_closed"].includes(grant.retention.state))
    ) {
      await Leases.settle(observed, {
        kind: "closed",
        grantID: grant.grantID,
        generation: grant.state === "bound" ? grant.retention.generation : 0,
        reason:
          grant.state === "closed"
            ? "closed"
            : grant.retention.state === "handoff_closed"
              ? "handoff_closed"
              : "control_closed",
        inspectedAt: inspected.inspectedAt,
      })
      return
    }
    if (grant.state === "bound" && grant.retention.state === "released") {
      throw new Error("A released generation lacks its canonical terminal receipt")
    }
    const run = await RolloutLedger.getRun(
      { kind: "session", scopeID: entry.authority.projectID, sessionID: entry.authority.sessionID },
      entry.authority.rootID,
    ).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return
    const evidence = await RolloutQuery.releaseEvidence(entry.authority.sessionID, entry.authority.rootID, signal)
    if (!evidence) return true
    const receipt = await input.resources.release(
      Execution.ReleaseProof.parse({
        ...proof,
        purpose: "execution-resources-release",
        grantID: grant.grantID,
        generation: grant.state === "bound" ? grant.retention.generation : 0,
        outcome: evidence.status,
        materialized: !evidence.admissionOnly,
      }),
      signal,
    )
    signal.throwIfAborted()
    await Leases.settle(observed, { kind: "terminal", receipt })
    await settleOriginal(observed, receipt)
  }
  function retryLater(target: Target) {
    if (!enqueue(retry, target)) retryFull = true
  }
  async function scan(target?: Target) {
    let after: string | undefined
    do {
      signal.throwIfAborted()
      const page = await Leases.page(input.connection.runtimeID, { after, limit: 16, target })
      for (let index = 0; index < page.items.length; index += 2) {
        await Promise.all(
          page.items.slice(index, index + 2).map(async (entry) => {
            try {
              if (await settle(entry)) retryLater(entry.authority)
            } catch (error) {
              if (!signal.aborted) {
                retryLater(entry.authority)
                log.warn("execution cleanup remains unresolved", {
                  sessionID: entry.authority.sessionID,
                  rootID: entry.authority.rootID,
                  error,
                })
              }
            }
          }),
        )
      }
      after = page.cursor
    } while (after)
  }
  function wake(target?: Target) {
    if (stopped || signal.aborted) return
    if (target && !enqueue(ready, target)) full = true
    if (current) return
    const task = (async () => {
      while (!stopped && (full || ready.size)) {
        const all = full
        full = false
        const selected = all ? undefined : ready.values().next().value
        if (all) ready.clear()
        else if (selected) ready.delete(JSON.stringify([selected.sessionID, selected.rootID]))
        const partition = selected ? JSON.stringify([selected.sessionID, selected.rootID]) : "*"
        try {
          await scan(selected)
          if (scanFailure?.partition === partition) scanFailure = undefined
        } catch (error) {
          if (!signal.aborted) {
            scanFailure = { partition, error }
            if (selected) retryLater(selected)
            else retryFull = true
            log.warn("execution cleanup scan remains unresolved", { error })
          }
        }
      }
    })().finally(() => {
      current = undefined
      if (stopped || signal.aborted) return
      if (full || ready.size) {
        wake()
        return
      }
      if (!timer && (retryFull || retry.size))
        timer = setTimeout(() => {
          timer = undefined
          full ||= retryFull
          retryFull = false
          for (const target of retry.values()) if (!enqueue(ready, target)) full = true
          retry.clear()
          wake()
        }, 1000)
    })
    current = task
  }
  const unsubscribeLeases = Leases.subscribe(wake)
  const unsubscribeRuns = Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
    const record = event.properties.record
    if (
      record.kind === "run" &&
      record.value.owner.kind === "session" &&
      ["completed", "failed", "cancelled"].includes(record.value.status)
    )
      wake({ sessionID: record.value.owner.sessionID, rootID: record.value.id })
  })
  function close() {
    if (closing) return closing
    stopped = true
    unsubscribeLeases()
    unsubscribeRuns()
    if (timer) clearTimeout(timer)
    ready.clear()
    retry.clear()
    signal.removeEventListener("abort", onAbort)
    controller.abort()
    return (closing = Promise.resolve(current).then(() => {
      if (scanFailure) throw new AggregateError([scanFailure.error], "Execution cleanup index could not drain")
    }))
  }
  function onAbort() {
    void close().catch((error) => log.warn("execution release observer cleanup failed", { error }))
  }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  else wake()
  return close
}
