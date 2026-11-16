import { expect } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import { OrganizationRecord } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as ServiceKeys } from "../../../organization/src/storage/path"
import type { completedHostedTask } from "./hosted-task"

type Selected = Parameters<typeof completedHostedTask>[0]
type Task = Awaited<ReturnType<typeof completedHostedTask>>

export async function terminalHostedCancel(selected: Selected, task: Task) {
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const baseline = task.calls.length
  const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
  const before = await selected.runtime.run(() => RolloutLedger.getRun(owner, task.nativeRelease.rootID))
  expect(before).toMatchObject({ status: "completed", recording: "complete" })
  expect(before.cancelRequestedAt).toBeUndefined()
  const paused = (
    await selected.service.client.orgCommands.control(
      {
        sessionID: task.sessionID,
        orgCommandControlRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID: "terminal-cancel-history-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  if (paused.effect.operation !== "pause") throw new Error("Expected the actual terminal cancel pause receipt")
  const request = {
    ...task.target,
    sessionID: task.sessionID,
    requestID: "terminal-cancel-history",
    control: { operation: "cancel" as const, runID: before.id, controlVersion: paused.effect.controlVersion },
  }
  const accepted = (
    await selected.service.client.orgCommands.control(
      { sessionID: task.sessionID, orgCommandControlRequest: request },
      options,
    )
  ).data
  if (accepted.effect.operation !== "cancel") throw new Error("Expected the actual terminal Cancel receipt")
  expect(accepted.permit.payloadHash).toBe(await Command.digestControl(request))
  expect(accepted.effect).toMatchObject({
    runID: before.id,
    runStatusAtReception: "completed",
    controlVersion: paused.effect.controlVersion + 1,
  })
  expect(accepted.effect.cancelRequestedAt).toBeUndefined()
  const after = await selected.runtime.run(() => RolloutLedger.getRun(owner, before.id))
  expect(after).toEqual(before)
  expect(task.calls).toHaveLength(baseline)
  expect(await selected.runtime.run(() => RolloutLedger.tools(owner, before.id))).toEqual([])
  expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
  expect(await selected.runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
  const retained = await selected.service.client.orgCommands.get(
    { sessionID: task.sessionID, requestID: request.requestID },
    options,
  )
  expect(retained.data.accepted).toEqual(accepted)
  return { accepted, runID: before.id, baseline }
}

export async function settledHostedQuestion(selected: Selected, task: Task) {
  const baseline = task.calls.length
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
  const answer = "native-only-recovery-private-question-answer"
  const cleanupReason = new Error("Owned recovery question cleanup")
  const native = await selected.runtime.run(async () =>
    ScopeContext.provide({
      scope: task.info.scope,
      workspace: null,
      fn: async () => {
        const controller = new AbortController()
        const asked = Promise.withResolvers<string>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, ({ properties }) => {
          if (properties.sessionID === task.sessionID) asked.resolve(properties.id)
        })
        const settled = Question.ask({
          sessionID: task.sessionID,
          questions: [{ question: "Private recovery value", header: "Recovery", options: [], input_type: "password" }],
          signal: controller.signal,
        }).then(
          (answers) => ({ kind: "resolved" as const, answers }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        return {
          controller,
          unsubscribe,
          settled,
          ready: asked.promise.then((requestID) => ({ kind: "asked" as const, requestID })),
        }
      },
    }),
  )
  let originalFailure: { error: unknown } | undefined
  try {
    const ready = await Promise.race([native.ready, native.settled])
    if (ready.kind === "rejected") throw ready.error
    if (ready.kind !== "asked") throw new Error("Original question settled before actual asked readiness")
    const request = {
      ...task.target,
      sessionID: task.sessionID,
      requestID: "settled-question-history",
      decision: {
        operation: "decision" as const,
        kind: "question" as const,
        requestID: ready.requestID,
        reply: "answer" as const,
        answers: [[answer]],
      },
    }
    const accepted = (
      await selected.service.client.orgSessionInteractions.reply(
        { sessionID: task.sessionID, orgCommandDecisionRequest: request },
        options,
      )
    ).data
    const settled = await native.settled
    if (settled.kind === "rejected") throw settled.error
    expect(settled.answers).toEqual([[answer]])
    expect(accepted.permit.payloadHash).toBe(await Command.digestDecision(request))
    expect(accepted.effect).toMatchObject({
      kind: "decision",
      sourceSessionID: task.sessionID,
      requestID: ready.requestID,
      decision: {
        status: "resolved",
        winner: {
          actor: { subjectID: selected.service.identity.accountID },
          outcome: { kind: "question", reply: "answer" },
        },
      },
    })
    const receipt = await selected.runtime.run(async () =>
      ScopeContext.provide({
        scope: task.info.scope,
        workspace: null,
        fn: () => Question.reconcile({ sessionID: task.sessionID, requestID: ready.requestID }),
      }),
    )
    expect(receipt).toMatchObject({
      sessionID: task.sessionID,
      requestID: ready.requestID,
      outcome: { kind: "question", reply: "answer", answers: [["[redacted]"]] },
    })
    expect(JSON.stringify(accepted)).not.toContain(answer)
    const retained = await selected.service.client.orgCommands.get(
      { sessionID: task.sessionID, requestID: request.requestID },
      options,
    )
    expect(retained.data.accepted).toEqual(accepted)
    expect(JSON.stringify(retained.data)).not.toContain(answer)
    const serviceRecords = await selected.service.service.maintenance.run(async () =>
      Promise.all([
        OrganizationRecord.read(
          OrganizationRecord.CommandRequest,
          ServiceKeys.commandRequest(accepted.permit.actor.subjectID, accepted.permit.requestID),
        ),
        OrganizationRecord.read(
          OrganizationRecord.CommandAttempt,
          ServiceKeys.commandAttempt(accepted.permit.attemptID),
        ),
      ]),
    )
    expect(JSON.stringify(serviceRecords)).not.toContain(answer)
    expect(task.calls).toHaveLength(baseline)
    expect(await selected.runtime.run(() => RolloutLedger.tools(owner, task.nativeRelease.rootID))).toEqual([])
    expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
    expect(await selected.runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
    return { accepted, requestID: ready.requestID, receipt, baseline }
  } catch (error) {
    originalFailure = { error }
    throw error
  } finally {
    try {
      await selected.runtime.run(async () =>
        ScopeContext.provide({
          scope: task.info.scope,
          workspace: null,
          fn: async () => {
            native.unsubscribe()
            native.controller.abort(cleanupReason)
            const settled = await native.settled
            if (
              settled.kind === "rejected" &&
              settled.error !== cleanupReason &&
              settled.error !== originalFailure?.error
            )
              throw settled.error
          },
        }),
      )
    } catch (error) {
      if (originalFailure && originalFailure.error !== error)
        throw new AggregateError([originalFailure.error, error], "Question fixture and its native cleanup failed")
      throw error
    }
  }
}
