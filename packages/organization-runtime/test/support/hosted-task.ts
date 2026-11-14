import { expect } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
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

interface HostedTaskRuntime {
  service: Awaited<ReturnType<typeof fixture>>
  registration: { runtimeID: string }
  runtime: { run<T>(body: () => Promise<T>): Promise<T> }
}

async function startHostedTask(selected: HostedTaskRuntime, hold: boolean) {
  const started = Promise.withResolvers<void>()
  const calls: unknown[] = []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
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
    await bounded(started.promise)
    return {
      sessionID,
      accepted,
      target,
      model,
      calls,
      upstream,
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

async function releasedTask(selected: HostedTaskRuntime, requestID: string) {
  const releaseKey = Keys.release(selected.service.identity.orgID, selected.service.identity.accountID, requestID)
  return until(() =>
    selected.runtime.run(async () => {
      const [raw] = await Storage.readMany([releaseKey])
      const value = raw === undefined ? undefined : Records.Release.parse(raw)
      return value?.state === "released" ? value : undefined
    }),
  )
}

export async function appendCompletedHostedTask(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
) {
  const requestID = "restored-second-input"
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
  const release = await releasedTask(selected, requestID)
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

export async function verifyCompletedTaskHistory(
  selected: HostedTaskRuntime,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
) {
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
