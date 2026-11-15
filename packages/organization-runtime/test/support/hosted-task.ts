import { expect } from "bun:test"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationCommandHistory } from "../../../organization/src/command-history"
import { OrganizationExecutionGrants } from "../../../organization/src/execution-grants"
import { OrganizationGatewayHistory } from "../../../organization/src/gateway-calls"
import { OrganizationStoragePath as ServiceKeys } from "../../../organization/src/storage/path"
import { OrganizationRecord } from "../../../organization/src/storage/records"
import { OrganizationCommandRecords as Records } from "../../src/command-records"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import { OrganizationIntakePath as Keys } from "../../src/storage/path"
import type { fixture } from "./organization"
import { observeTaskFailure } from "./task-failure"

interface HostedTaskRuntime {
  service: Awaited<ReturnType<typeof fixture>>
  registration: { runtimeID: string }
  runtime: { run<T>(body: () => Promise<T>): Promise<T> }
  connectionObservation?(): {
    connectionCloseCount: number
    connectionCloses: readonly {
      code: number
      reason?: "rejected" | "registration_revoked" | "account_removed" | "other"
      observedAt?: number
      readyState: number
      pendingFrames: number
      pendingBytes: number
      epoch: number
      elapsedMs: number
      leaseRemainingMs: number
    }[]
  }
}

async function startHostedTask(
  selected: HostedTaskRuntime,
  hold: boolean,
  initialResponse: "complete" | "terminal-refusal" = "complete",
) {
  let responseMode = initialResponse
  const started = Promise.withResolvers<void>()
  const calls: unknown[] = []
  let upstreamHeaders = 0
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamHeaders++
      calls.push(await request.json())
      started.resolve()
      if (hold)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.add(controller)
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"before-recovery","created":1,"model":"recovery-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Before recovery"},"finish_reason":null}]}\n\n',
                ),
              )
            },
            cancel() {
              streams.clear()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (responseMode === "terminal-refusal")
        return new Response(
          'data: {"error":{"message":"The saved request is invalid","type":"invalid_request_error","code":"invalid_prompt"}}\n\ndata: [DONE]\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      return new Response(
        [
          'data: {"id":"before-recovery","created":1,"model":"recovery-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Completed before recovery"},"finish_reason":null}]}',
          'data: {"id":"before-recovery","created":1,"model":"recovery-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const bounded = async <T>(work: Promise<T>) => {
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(() => timeout.reject(new Error("Actual Hosted task barrier did not complete")), 4000)
    try {
      return await Promise.race([work, timeout.promise])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const f = selected.service
    const options = { headers: f.headers, throwOnError: true as const }
    const project = (
      await f.client.orgProjects.create({ orgProjectCreate: { name: "Restored task", description: "" } }, options)
    ).data
    const model = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Recovery model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: new URL("/v1", upstream.url).href,
              model: { id: "recovery-model", name: "Recovery", limit: { context: 128000, output: 4096 } },
            },
            credential: { kind: "bearer", value: "only-the-service-owns-this-model-key" },
          },
        },
        options,
      )
    ).data
    await f.client.orgResourceGrants.set(
      {
        resourceID: model.resourceID,
        kind: "account",
        subjectID: f.identity.accountID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    const target = {
      schemaVersion: 1 as const,
      orgID: f.identity.orgID,
      projectID: project.projectID,
      runtimeID: selected.registration.runtimeID,
    }
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            ...target,
            requestID: "restored-original-session",
            creation: { operation: "create", title: "Restore the original task" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await f.client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: {
            modelResourceID: model.resourceID,
            connectionResourceIDs: [],
            infrastructure: { workspace: null, environment: null },
          },
        },
      },
      options,
    )
    const accepted = (
      await f.client.orgCommands.input(
        {
          sessionID,
          orgCommandInputRequest: {
            ...target,
            sessionID,
            requestID: "restored-original-input",
            input: {
              operation: "input",
              mode: "task",
              parts: [{ type: "text", text: "Complete this task once" }],
            },
          },
        },
        options,
      )
    ).data
    const waitingAt = Date.now()
    try {
      await bounded(started.promise)
    } catch (error) {
      console.error(
        "HOSTED_TASK_START_FAILURE",
        JSON.stringify({
          stage: "hosted-model-start",
          inputAccepted: true,
          observedAt: Date.now(),
          waitedMs: Date.now() - waitingAt,
          upstreamHeaders,
          upstreamBodies: calls.length,
          ...selected.connectionObservation?.(),
        }),
      )
      await observeTaskFailure({
        runtime: selected.runtime,
        accepted,
        stage: "hosted-model-start",
        upstreamCalls: calls.length,
      }).catch(() => undefined)
      throw error
    }
    return {
      sessionID,
      accepted,
      target,
      model,
      calls,
      upstreamObservation() {
        return { headers: upstreamHeaders, bodies: calls.length }
      },
      upstream,
      completeResponses() {
        responseMode = "complete"
      },
      interrupt() {
        for (const stream of streams) stream.error(new Error("The original upstream response was interrupted"))
        streams.clear()
      },
      [Symbol.asyncDispose]: () => upstream.stop(true),
    }
  } catch (error) {
    await upstream.stop(true)
    throw error
  }
}

async function until<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 4000
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("The original Hosted task did not settle")
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

async function releasedTask(
  selected: HostedTaskRuntime,
  requestID: string,
  observe?: (value: ReturnType<typeof Records.Release.parse> | undefined) => void,
) {
  const releaseKey = Keys.release(selected.service.identity.orgID, selected.service.identity.accountID, requestID)
  return until(() =>
    selected.runtime.run(async () => {
      const [raw] = await Storage.readMany([releaseKey])
      const value = raw === undefined ? undefined : Records.Release.parse(raw)
      observe?.(value)
      return value?.state === "released" ? value : undefined
    }),
  )
}

export async function appendCompletedHostedTask(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
) {
  const requestID = "restored-second-input"
  const baseline = task.upstreamObservation()
  const accepted = (
    await selected.service.client.orgCommands.input(
      {
        sessionID: task.sessionID,
        orgCommandInputRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID,
          input: {
            operation: "input",
            mode: "task",
            parts: [{ type: "text", text: "Complete a second original task" }],
          },
        },
      },
      { headers: selected.service.headers, throwOnError: true },
    )
  ).data
  const waitingAt = Date.now()
  let reads = 0
  let last: Record<string, unknown> | undefined
  const release = await releasedTask(selected, requestID, (value) => {
    reads++
    const observedAt = Date.now()
    last = {
      observedAt,
      releaseState: value?.state ?? "missing",
      receiptOutcome: value?.receipt?.outcome ?? "absent",
      originalRelease:
        value !== undefined &&
        value.sessionID === accepted.permit.sessionID &&
        value.rootID === accepted.effect.messageID &&
        value.runtimeID === accepted.permit.runtimeID &&
        value.bindingEpoch === accepted.permit.bindingEpoch &&
        value.grantID === accepted.permit.provisionalGrantID,
    }
    try {
      const manager = SessionManager.getRuntime(task.sessionID)
      const activity = manager?.status.type === "busy" ? manager.status.activity : undefined
      Object.assign(last, {
        managerPresent: manager !== undefined,
        ownerPresent: manager?.owner !== undefined,
        ownerRootMatches: manager?.owner?.rootID === accepted.effect.messageID,
        ownerAborted: manager?.owner?.lease.signal.aborted ?? "absent",
        loopPhase: manager?.owner?.phase ?? "absent",
        executionPhase: manager?.executionPhase ?? "absent",
        activityPhase: activity?.phase ?? "absent",
        activityRootMatches: activity?.rootID === accepted.effect.messageID,
        activityAgeMs: activity ? Math.max(0, observedAt - activity.startedAt) : "absent",
      })
    } catch {
      last.managerObservation = "unavailable"
    }
  }).catch(async (error) => {
    const upstream = task.upstreamObservation()
    console.error(
      "HOSTED_TASK_RELEASE_FAILURE",
      JSON.stringify({
        stage: "second-original-release",
        inputAccepted: true,
        inputAcceptedAt: accepted.acceptedAt,
        inputConnectionEpoch: accepted.permit.connectionEpoch,
        releaseWaitingAt: waitingAt,
        observedAt: Date.now(),
        waitedMs: Date.now() - waitingAt,
        reads,
        last,
        upstreamHeadersSinceInput: upstream.headers - baseline.headers,
        upstreamBodiesSinceInput: upstream.bodies - baseline.bodies,
        ...selected.connectionObservation?.(),
      }),
    )
    await observeTaskFailure({
      runtime: selected.runtime,
      accepted,
      stage: "second-original-release",
      upstreamCalls: upstream.bodies - baseline.bodies,
    })
    throw error
  })
  expect(release.receipt?.outcome).toBe("completed")
  await until(() =>
    selected.runtime.run(async () => ((await OrganizationExecutionLeases.pendingForCapture()) ? undefined : true)),
  )
  return accepted
}

export async function completedHostedTask(selected: HostedTaskRuntime) {
  const task = await startHostedTask(selected, false)
  try {
    const nativeRelease = await releasedTask(selected, "restored-original-input")
    expect(nativeRelease.receipt?.outcome).toBe("completed")
    await until(() =>
      selected.runtime.run(async () => ((await OrganizationExecutionLeases.pendingForCapture()) ? undefined : true)),
    )
    const info = await selected.runtime.run(() => Session.get(task.sessionID))
    const gateway = await selected.service.service.maintenance.run(async () => {
      const rows = []
      for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 }))
        rows.push(OrganizationRecord.GatewayCall.parse(row.value))
      return rows
    })
    expect(gateway.length).toBeGreaterThan(0)
    expect(gateway.every((row) => row.receipt.state === "response_complete")).toBe(true)
    const recorded = await selected.runtime.run(() =>
      RolloutLedger.calls({ kind: "session", scopeID: info.scope.id, sessionID: info.id }, nativeRelease.rootID),
    )
    expect(recorded.every((call) => call.status === "completed")).toBe(true)
    expect(task.calls).toHaveLength(recorded.length)
    expect(gateway).toHaveLength(recorded.length)
    return { ...task, info, nativeRelease }
  } catch (error) {
    await task[Symbol.asyncDispose]()
    throw error
  }
}

export async function failedHostedTask(selected: HostedTaskRuntime) {
  const task = await startHostedTask(selected, false, "terminal-refusal")
  try {
    const nativeRelease = await releasedTask(selected, "restored-original-input")
    expect(nativeRelease.receipt?.outcome).toBe("failed")
    await until(() =>
      selected.runtime.run(async () => ((await OrganizationExecutionLeases.pendingForCapture()) ? undefined : true)),
    )
    const info = await selected.runtime.run(() => Session.get(task.sessionID))
    const owner = { kind: "session" as const, scopeID: info.scope.id, sessionID: info.id }
    const run = await selected.runtime.run(() => RolloutLedger.getRun(owner, nativeRelease.rootID))
    expect(run).toMatchObject({ id: task.accepted.effect.messageID, status: "failed" })
    expect(run.recording).not.toBe("failed")
    const messages = await selected.runtime.run(() =>
      ScopeContext.provide({
        scope: info.scope,
        workspace: info.workspace,
        fn: () => SessionHistory.modelMessages({ sessionID: info.id }),
      }),
    )
    const latest = messages.findLast((message) => message.info.role === "assistant")?.info
    if (!latest || latest.role !== "assistant") throw new Error("The real failed provider left no assistant result")
    expect(latest.rootID).toBe(run.id)
    expect(latest.error).toBeDefined()
    const gateway = await selected.service.service.maintenance.run(async () => {
      const rows = []
      for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 }))
        rows.push(OrganizationRecord.GatewayCall.parse(row.value))
      return rows
    })
    expect(gateway.length).toBeGreaterThan(0)
    expect(gateway.every((row) => row.receipt.state === "response_complete")).toBe(true)
    const recorded = await selected.runtime.run(() => RolloutLedger.calls(owner, run.id))
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded.every((call) => call.status === "failed")).toBe(true)
    expect(task.calls).toHaveLength(recorded.length)
    expect(gateway).toHaveLength(recorded.length)
    expect(await selected.runtime.run(() => RolloutLedger.tools(owner, run.id))).toEqual([])
    expect(await selected.runtime.run(async () => SessionManager.isRunning(info.id))).toBe(false)
    const paused = (
      await selected.service.client.orgCommands.control(
        {
          sessionID: info.id,
          orgCommandControlRequest: {
            ...task.target,
            sessionID: info.id,
            requestID: "saved-failed-root-pause",
            control: { operation: "pause" },
          },
        },
        { headers: selected.service.headers, throwOnError: true },
      )
    ).data
    if (paused.effect.operation !== "pause") throw new Error("The failed saved root did not receive a real Pause")
    const saved = await selected.runtime.run(() => Session.get(info.id))
    expect(saved.paused?.since).toBe(paused.effect.pausedSince)
    expect(task.calls).toHaveLength(recorded.length)
    return { ...task, info: saved, nativeRelease }
  } catch (error) {
    try {
      await task[Symbol.asyncDispose]()
    } catch (cleanup) {
      if (cleanup !== error)
        throw new AggregateError([error, cleanup], "Failed-root fixture and original upstream cleanup failed")
    }
    throw error
  }
}

export async function pausedHostedTask(selected: HostedTaskRuntime) {
  const task = await startHostedTask(selected, true)
  try {
    const paused = (
      await selected.service.client.orgCommands.control(
        {
          sessionID: task.sessionID,
          orgCommandControlRequest: {
            ...task.target,
            sessionID: task.sessionID,
            requestID: "pause-for-native-backup",
            control: { operation: "pause" },
          },
        },
        { headers: selected.service.headers, throwOnError: true },
      )
    ).data
    expect(paused.effect.operation).toBe("pause")
    const info = await selected.runtime.run(() => Session.get(task.sessionID))
    expect(info.paused).toBeDefined()
    task.interrupt()
    const gateway = await until(() =>
      selected.service.service.maintenance.run(async () => {
        const rows = []
        for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 }))
          rows.push(OrganizationRecord.GatewayCall.parse(row.value))
        return rows.some((row) => row.receipt.state === "unknown") ? rows : undefined
      }),
    )
    expect(gateway.some((row) => row.receipt.state === "unknown")).toBe(true)
    return { ...task, info, gateway }
  } catch (error) {
    await task[Symbol.asyncDispose]()
    throw error
  }
}

export async function verifyClosedTaskHistory(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  outcome: "completed" | "failed" = "completed",
) {
  expect(task.nativeRelease.receipt?.outcome).toBe(outcome)
  const rows = await selected.service.service.maintenance.run(async () => {
    const values = new Map<string, unknown>()
    for await (const row of Storage.records({ prefix: ["organization"], limit: 128 }))
      values.set(JSON.stringify(row.key), row.value)
    return values
  })
  const reader: OrganizationRecord.HistoricalReader = {
    read(schema, key) {
      return schema.parse(rows.get(JSON.stringify(key)))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const parsed: string[] = JSON.parse(key)
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value }
      }
    },
  }
  const grantID = task.nativeRelease.grantID
  const grant = await OrganizationExecutionGrants.closedHistory(reader, grantID)
  expect(await OrganizationGatewayHistory.grant(reader, grant)).toBe(task.calls.length)
  const stateKey = ServiceKeys.commandState(task.sessionID)
  expect(
    await OrganizationCommandHistory.validate(reader, stateKey, reader.read(OrganizationRecord.CommandState, stateKey)),
  ).toBe(true)
  const change = async (key: string[], value: unknown, verify: () => Promise<unknown>) => {
    const address = JSON.stringify(key)
    const original = rows.get(address)
    if (value === undefined) rows.delete(address)
    else rows.set(address, value)
    try {
      await expect(verify()).rejects.toThrow()
    } finally {
      rows.set(address, original)
    }
  }
  const attemptKey = ServiceKeys.commandAttempt(task.accepted.permit.attemptID)
  const attempt = reader.read(OrganizationRecord.CommandAttempt, attemptKey)
  await change(
    attemptKey,
    { ...attempt, authorization: { ...attempt.authorization, signature: "0".repeat(128) } },
    () => OrganizationExecutionGrants.closedHistory(reader, grantID),
  )
  await change(ServiceKeys.executionRelease(grantID, grant.retention.generation), undefined, () =>
    OrganizationExecutionGrants.closedHistory(reader, grantID),
  )
  await change(ServiceKeys.sessionCommand(task.sessionID, task.accepted.permit.commandSeq), undefined, () =>
    OrganizationCommandHistory.validate(reader, stateKey, reader.read(OrganizationRecord.CommandState, stateKey)),
  )
  const gatewayRow = [...reader.entries(ServiceKeys.gatewayCall(grantID, "").slice(0, -1))][0]
  if (!gatewayRow) throw new Error("Expected the original model gateway call")
  const gateway = OrganizationRecord.GatewayCall.parse(gatewayRow.value)
  await change(gatewayRow.key, { ...gateway, receipt: { ...gateway.receipt, state: "unknown" } }, () =>
    OrganizationGatewayHistory.validate(reader, gatewayRow.key, rows.get(JSON.stringify(gatewayRow.key))),
  )
  const usageKey = ServiceKeys.executionUsage(grantID)
  const usage = reader.read(OrganizationRecord.ExecutionUsage, usageKey)
  await change(usageKey, { ...usage, calls: usage.calls + 1 }, () =>
    OrganizationGatewayHistory.validate(reader, usageKey, rows.get(JSON.stringify(usageKey))),
  )
  const foreignID = "different-canonical-grant"
  const foreignGrant = { ...grant, grantID: foreignID }
  const foreignKeys: string[] = []
  for (const row of reader.entries(ServiceKeys.gatewayCall(grantID, "").slice(0, -1))) {
    const value = OrganizationRecord.GatewayCall.parse(row.value)
    const key = JSON.stringify(ServiceKeys.gatewayCall(foreignID, value.authorization.permit.callID))
    rows.set(key, row.value)
    foreignKeys.push(key)
  }
  const foreignUsage = JSON.stringify(ServiceKeys.executionUsage(foreignID))
  rows.set(foreignUsage, { ...usage, grantID: foreignID })
  try {
    await expect(OrganizationGatewayHistory.grant(reader, foreignGrant)).rejects.toThrow("complete released call")
  } finally {
    for (const key of foreignKeys) rows.delete(key)
    rows.delete(foreignUsage)
  }
  expect((await OrganizationExecutionGrants.closedHistory(reader, grantID)).rootID).toBe(task.accepted.effect.messageID)
}

export async function continueQueuedHostedTask(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  requestID: string,
) {
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const baseline = task.calls.length
  const paused = (
    await selected.service.client.orgCommands.control(
      {
        sessionID: task.sessionID,
        orgCommandControlRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID: requestID + "-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  if (paused.effect.operation !== "pause") throw new Error("Expected the actual queued-task pause receipt")
  const accepted = (
    await selected.service.client.orgCommands.input(
      {
        sessionID: task.sessionID,
        orgCommandInputRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID,
          input: {
            operation: "input",
            mode: "task",
            parts: [{ type: "text", text: "Complete the explicitly continued queued task once" }],
          },
        },
      },
      options,
    )
  ).data
  const saved = await selected.runtime.run(() => Session.get(task.sessionID))
  expect(saved.paused?.since).toBe(paused.effect.pausedSince)
  const queued = await selected.runtime.run(() => SessionInbox.peekReady(task.sessionID))
  expect(
    queued.some(
      (item) =>
        item.id === accepted.effect.itemID && item.messageID === accepted.effect.messageID && item.mode === "task",
    ),
  ).toBe(true)
  expect(task.calls).toHaveLength(baseline)
  expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
  const request = {
    ...task.target,
    sessionID: task.sessionID,
    requestID: requestID + "-continue",
    control: {
      operation: "continue" as const,
      pausedSince: paused.effect.pausedSince,
      controlVersion: paused.effect.controlVersion,
    },
  }
  const continued = (
    await selected.service.client.orgCommands.control(
      { sessionID: task.sessionID, orgCommandControlRequest: request },
      options,
    )
  ).data
  if (continued.effect.operation !== "continue") throw new Error("Expected the actual queued-task Continue receipt")
  expect(continued.permit.payloadHash).toBe(await Command.digestControl(request))
  expect(continued.effect).toMatchObject({
    itemID: accepted.effect.itemID,
    messageID: accepted.effect.messageID,
    rootID: accepted.effect.messageID,
    pausedSince: paused.effect.pausedSince,
    controlVersion: paused.effect.controlVersion + 1,
  })
  const release = await releasedTask(selected, requestID)
  expect(release).toMatchObject({
    state: "released",
    rootID: accepted.effect.messageID,
    grantID: accepted.permit.provisionalGrantID,
    bindingEpoch: accepted.permit.bindingEpoch,
    receipt: { outcome: "completed" },
  })
  await until(() =>
    selected.runtime.run(async () => ((await OrganizationExecutionLeases.pendingForCapture()) ? undefined : true)),
  )
  const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
  expect(await selected.runtime.run(() => RolloutLedger.getRun(owner, accepted.effect.messageID))).toMatchObject({
    status: "completed",
    recording: "complete",
  })
  expect(await selected.runtime.run(() => RolloutLedger.tools(owner, accepted.effect.messageID))).toEqual([])
  const recorded = await selected.runtime.run(() => RolloutLedger.calls(owner, accepted.effect.messageID))
  expect(recorded.length).toBeGreaterThan(0)
  expect(recorded.every((call) => call.status === "completed")).toBe(true)
  expect(task.calls.length - baseline).toBe(recorded.length)
  return { paused, accepted, continued, release }
}

export async function continueRestoredHostedTask(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  queued?: Awaited<ReturnType<typeof queuedHostedTask>>,
) {
  const accepted = queued?.accepted ?? task.accepted
  const rootID = accepted.effect.messageID
  const originGrantID = accepted.permit.provisionalGrantID
  if (!originGrantID) throw new Error("The original saved task lacks its admitted grant")
  const baseline = task.calls.length
  const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
  const saved = await selected.runtime.run(() => Session.get(task.sessionID))
  const before = queued ? [] : await selected.runtime.run(() => RolloutLedger.calls(owner, rootID))
  const beforeSegments = queued ? [] : await selected.runtime.run(() => RolloutLedger.segments(owner, rootID))
  expect(saved.paused).toBeDefined()
  expect(await selected.runtime.run(async () => SessionManager.isRunning(saved.id))).toBe(false)
  expect(task.calls).toHaveLength(baseline)
  if (queued) {
    expect(await selected.runtime.run(() => SessionInbox.getStored(saved.id, accepted.effect.itemID))).toEqual(
      queued.inbox,
    )
    expect(
      await selected.runtime.run(() =>
        Storage.read(Keys.release(accepted.permit.orgID, accepted.permit.actor.subjectID, accepted.permit.requestID)),
      ),
    ).toEqual(queued.release)
    await expect(selected.runtime.run(() => RolloutLedger.getRun(owner, rootID))).rejects.toBeInstanceOf(
      Storage.NotFoundError,
    )
    await expect(
      selected.runtime.run(() =>
        MessageV2.readInfo({ scopeID: saved.scope.id, sessionID: saved.id, messageID: rootID }),
      ),
    ).rejects.toBeInstanceOf(Storage.NotFoundError)
  }
  const deployment = await selected.service.service.deployment()
  const control = await selected.runtime.run(async () =>
    Records.ControlState.parse(await Storage.read(Keys.control(task.target.orgID, saved.id))),
  )
  const request = {
    ...task.target,
    sessionID: saved.id,
    requestID: queued ? "restored-saved-queued-input-continue" : "restored-saved-failed-root-continue",
    control: {
      operation: "continue" as const,
      pausedSince: saved.paused!.since,
      controlVersion: control.controlVersion,
    },
  }
  task.completeResponses()
  expect(task.calls).toHaveLength(baseline)
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const continued = (
    await selected.service.client.orgCommands.control(
      { sessionID: saved.id, orgCommandControlRequest: request },
      options,
    )
  ).data
  if (continued.effect.operation !== "continue") throw new Error("Expected an actual saved-root Continue receipt")
  expect(continued.permit.payloadHash).toBe(await Command.digestControl(request))
  expect(continued.permit.actor.subjectID).toBe(accepted.permit.actor.subjectID)
  expect(continued.permit.deploymentIncarnation).toBe(deployment.deploymentIncarnation)
  expect(continued.permit.deploymentIncarnation).not.toBe(accepted.permit.deploymentIncarnation)
  expect(continued.effect).toMatchObject({
    rootID: rootID,
    pausedSince: saved.paused!.since,
    controlVersion: control.controlVersion + 1,
  })
  if (queued) expect(continued.effect).toMatchObject({ itemID: accepted.effect.itemID, messageID: rootID, rootID })
  const settled = await until(() =>
    selected.runtime.run(async () => {
      for await (const row of Storage.records({ prefix: ["organization-execution-leases", "entries"], limit: 128 })) {
        const entry = OrganizationExecutionLeases.Entry.parse(row.value)
        if (
          entry.authority.sessionID === saved.id &&
          entry.authority.rootID === rootID &&
          entry.authority.control?.admissionID === continued.permit.admissionID &&
          entry.state === "settled" &&
          entry.settlement?.kind === "terminal"
        )
          return entry
      }
      return undefined
    }),
  ).catch(async (error) => {
    await observeTaskFailure({
      runtime: selected.runtime,
      accepted,
      stage: "native-release",
      upstreamCalls: task.calls.length,
    })
    console.error(
      "RECOVERY_CONTINUE_LEASES",
      JSON.stringify(
        await selected.runtime.run(async () => {
          const entries = []
          for await (const row of Storage.records({
            prefix: ["organization-execution-leases", "entries"],
            limit: 128,
          })) {
            const entry = OrganizationExecutionLeases.Entry.parse(row.value)
            entries.push({
              version: entry.version,
              currentControl: entry.authority.control?.admissionID === continued.permit.admissionID,
              state: entry.state,
              hint: entry.hint,
              settlement: entry.settlement?.kind,
            })
          }
          const session = await Session.get(task.sessionID)
          return {
            entries,
            resume: session.resume && {
              rootMatches: session.resume.rootID === rootID,
              actorMatches: session.resume.actor?.requestID === continued.permit.requestID,
              actorPresent: !!session.resume.actor,
            },
          }
        }),
      ),
    )
    throw error
  })
  expect(settled.authority.deploymentIncarnation).toBe(continued.permit.deploymentIncarnation)
  expect(settled.authority.originGrantID).toBe(originGrantID)
  expect(settled.settlement).toMatchObject({
    kind: "terminal",
    receipt: { outcome: "completed", rootID: rootID },
  })
  await until(() =>
    selected.runtime.run(async () => ((await OrganizationExecutionLeases.pendingForCapture()) ? undefined : true)),
  )
  const run = await selected.runtime.run(() => RolloutLedger.getRun(owner, rootID))
  expect(run).toMatchObject({ id: rootID, status: "completed" })
  expect(run.recording).not.toBe("failed")
  expect(await selected.runtime.run(() => RolloutLedger.tools(owner, run.id))).toEqual([])
  const recorded = await selected.runtime.run(() => RolloutLedger.calls(owner, run.id))
  const segments = await selected.runtime.run(() => RolloutLedger.segments(owner, run.id))
  const previousSegments = new Set(beforeSegments.map((segment) => segment.id))
  const appendedSegments = segments.filter((segment) => !previousSegments.has(segment.id))
  expect(appendedSegments).toHaveLength(1)
  expect(appendedSegments[0]).toMatchObject({ runID: rootID, status: "completed" })
  for (const original of before) expect(recorded.find((call) => call.id === original.id)).toEqual(original)
  const oldIDs = new Set(before.map((call) => call.id))
  const appended = recorded.filter((call) => !oldIDs.has(call.id))
  expect(appended.length).toBeGreaterThan(0)
  expect(appended.every((call) => call.status === "completed")).toBe(true)
  expect(task.calls.length - baseline).toBe(appended.length)
  expect(await selected.runtime.run(async () => SessionManager.isRunning(saved.id))).toBe(false)
  if (queued) {
    const originalRelease = await selected.runtime.run(async () =>
      Records.Release.parse(
        await Storage.read(
          Keys.release(accepted.permit.orgID, accepted.permit.actor.subjectID, accepted.permit.requestID),
        ),
      ),
    )
    expect(originalRelease).toMatchObject({ ...queued.release, state: "released" })
    expect(originalRelease.receipt).toBeUndefined()
    expect(originalRelease.reconciledAt).toBeDefined()
    const terminal = settled.settlement
    if (terminal?.kind !== "terminal") throw new Error("The restored input lacks its actual new terminal receipt")
    const successorGrantID = terminal.receipt.grantID
    const source = await selected.service.service.maintenance.run(async () => ({
      predecessor: OrganizationRecord.ExecutionGrant.parse(
        await Storage.read(ServiceKeys.executionGrant(originGrantID)),
      ),
      successor: OrganizationRecord.ExecutionGrant.parse(
        await Storage.read(ServiceKeys.executionGrant(successorGrantID)),
      ),
      session: OrganizationRecord.SessionDirectory.parse(await Storage.read(ServiceKeys.session(saved.id))),
    }))
    expect(source.predecessor).toMatchObject({
      ...queued.grant,
      state: "closed",
      controlClosure: {
        rootID,
        successorGrantID,
      },
    })
    expect(source.successor).toMatchObject({
      schemaVersion: 6,
      state: "bound",
      rootID,
      deploymentIncarnation: deployment.deploymentIncarnation,
      provenance: { originGrantID, predecessorGrantID: originGrantID, control: continued },
      retention: { state: "released" },
    })
    expect(source.session.retainedExecutionGrants).toBe(0)
  }
  const count = task.calls.length
  const duplicate = (
    await selected.service.client.orgCommands.control(
      { sessionID: saved.id, orgCommandControlRequest: request },
      options,
    )
  ).data
  expect(duplicate).toEqual(continued)
  expect(task.calls).toHaveLength(count)
  expect(await selected.runtime.run(() => RolloutLedger.calls(owner, run.id))).toEqual(recorded)
  expect(await selected.runtime.run(() => RolloutLedger.segments(owner, run.id))).toEqual(segments)
  return { continued, settled, run }
}

export async function queuedHostedTask(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  requestID: string,
) {
  const options = { headers: selected.service.headers, throwOnError: true as const }
  const baseline = task.calls.length
  const paused = (
    await selected.service.client.orgCommands.control(
      {
        sessionID: task.sessionID,
        orgCommandControlRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID: requestID + "-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  if (paused.effect.operation !== "pause") throw new Error("Expected the original queued capture Pause receipt")
  const input = {
    ...task.target,
    sessionID: task.sessionID,
    requestID,
    input: {
      operation: "input" as const,
      mode: "task" as const,
      parts: [{ type: "text" as const, text: "Keep this accepted original task queued across recovery" }],
    },
  }
  const accepted = (
    await selected.service.client.orgCommands.input(
      { sessionID: task.sessionID, orgCommandInputRequest: input },
      options,
    )
  ).data
  expect(accepted.permit.payloadHash).toBe(await Command.digestInput(input))
  const grantID = accepted.permit.provisionalGrantID
  if (!grantID) throw new Error("Queued task acceptance requires its original provisional grant")
  const saved = await selected.runtime.run(() => Session.get(task.sessionID))
  expect(saved.paused?.since).toBe(paused.effect.pausedSince)
  const inbox = await selected.runtime.run(() => SessionInbox.getStored(task.sessionID, accepted.effect.itemID))
  expect(inbox).toMatchObject({
    id: accepted.effect.itemID,
    sessionID: task.sessionID,
    mode: "task",
    messageID: accepted.effect.messageID,
    message: { role: "user", actor: { kind: "account", subjectID: accepted.permit.actor.subjectID, requestID } },
  })
  expect(inbox.status).toBeUndefined()
  expect(inbox.message?.parts.some((part) => part.type === "text" && part.text === input.input.parts[0].text)).toBe(
    true,
  )
  const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
  const unmaterialized = async () => {
    for (const read of [
      () => MessageV2.get({ sessionID: task.sessionID, messageID: accepted.effect.messageID }),
      () => RolloutLedger.getRun(owner, accepted.effect.messageID),
    ]) {
      let missing = false
      try {
        await selected.runtime.run(async () => {
          await read()
        })
      } catch (error) {
        if (!(error instanceof Storage.NotFoundError)) throw error
        missing = true
      }
      expect(missing).toBe(true)
    }
  }
  await unmaterialized()
  const releaseKey = Keys.release(accepted.permit.orgID, accepted.permit.actor.subjectID, requestID)
  const release = await selected.runtime.run(async () => Records.Release.parse(await Storage.read(releaseKey)))
  expect(release).toMatchObject({
    state: "pending",
    rootID: accepted.effect.messageID,
    grantID,
    admissionID: accepted.permit.admissionID,
    attemptID: accepted.permit.attemptID,
  })
  expect(release.receipt).toBeUndefined()
  const readEntries = () =>
    selected.runtime.run(async () => {
      const entries = []
      for await (const row of Storage.records({ prefix: ["organization-execution-leases", "entries"], limit: 128 })) {
        const entry = OrganizationExecutionLeases.Entry.parse(row.value)
        if (entry.authority.sessionID === task.sessionID && entry.authority.rootID === accepted.effect.messageID)
          entries.push(entry)
      }
      return entries
    })
  const entries = await readEntries()
  expect(entries).toHaveLength(1)
  const entry = entries[0]!
  expect(entry).toMatchObject({
    state: "pending",
    authority: {
      rootID: accepted.effect.messageID,
      originGrantID: accepted.permit.provisionalGrantID,
      input: {
        requestID,
        admissionID: accepted.permit.admissionID,
        attemptID: accepted.permit.attemptID,
        acceptedHash: OrganizationExecutionLeases.acceptedHash(accepted),
      },
    },
  })
  expect(entry.authority.control).toBeUndefined()
  expect(entry.hint).toBeUndefined()
  expect(entry.uncertainUntil).toBeUndefined()
  expect(entry.settlement).toBeUndefined()
  const serviceState = () =>
    selected.service.service.maintenance.run(async () => {
      const session = OrganizationRecord.SessionDirectory.parse(await Storage.read(ServiceKeys.session(task.sessionID)))
      const grant = OrganizationRecord.ExecutionGrant.parse(await Storage.read(ServiceKeys.executionGrant(grantID)))
      const gateway = []
      for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 })) {
        const call = OrganizationRecord.GatewayCall.parse(row.value)
        if (call.authorization.permit.rootID === accepted.effect.messageID) gateway.push(call)
      }
      return { session, grant, gateway }
    })
  const original = await serviceState()
  expect(original.grant).toMatchObject({
    state: "provisional",
    grantID,
    sessionID: task.sessionID,
    deploymentIncarnation: accepted.permit.deploymentIncarnation,
    admissionID: accepted.permit.admissionID,
    attemptID: accepted.permit.attemptID,
  })
  expect(original.session.retainedExecutionGrants).toBe(1)
  expect(original.gateway).toEqual([])
  expect(task.calls).toHaveLength(baseline)
  expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
  return {
    paused,
    accepted,
    inbox,
    release,
    entries,
    grant: original.grant,
    baseline,
    async verifyUnchanged() {
      expect(await selected.runtime.run(() => SessionInbox.getStored(task.sessionID, accepted.effect.itemID))).toEqual(
        inbox,
      )
      expect(await selected.runtime.run(async () => Records.Release.parse(await Storage.read(releaseKey)))).toEqual(
        release,
      )
      const observed = await readEntries()
      expect(observed).toHaveLength(2)
      const pending = observed.filter((value) => value.state === "pending")
      expect(pending).toHaveLength(1)
      const generation = pending[0]!
      expect(generation.entryID).not.toBe(entry.entryID)
      expect(generation).toEqual(
        OrganizationExecutionLeases.Entry.parse({
          version: entry.version,
          entryID: generation.entryID,
          authority: entry.authority,
          hint: { grantID, generation: 0 },
          state: "pending",
        }),
      )
      expect(observed.find((value) => value.entryID === entry.entryID)).toEqual({
        ...entry,
        state: "settled",
        settlement: { kind: "linked", entryID: generation.entryID },
      })
      const current = await serviceState()
      expect(current.grant).toEqual(original.grant)
      expect(current.session.retainedExecutionGrants).toBe(1)
      expect(current.gateway).toEqual([])
      await unmaterialized()
      expect((await selected.runtime.run(() => Session.get(task.sessionID))).paused).toEqual(saved.paused)
      expect(task.calls).toHaveLength(baseline)
      expect(await selected.runtime.run(async () => SessionManager.isRunning(task.sessionID))).toBe(false)
    },
  }
}
