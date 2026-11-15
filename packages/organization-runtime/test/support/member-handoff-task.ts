import { expect } from "bun:test"
import path from "node:path"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { ModelExecution } from "@ericsanchezok/synergy-harness/execution/model-execution"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffRecord } from "../../../organization/src/handoff-record"
import { OrganizationRecord } from "../../../organization/src/storage/records"
import { OrganizationStoragePath } from "../../../organization/src/storage/path"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import type { openMemberRuntime } from "../../src/runtime"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import { completedHostedTask } from "./hosted-task"
import { createHandoffCompletion } from "./handoff-completion"

type Target = Parameters<typeof completedHostedTask>[0] & {
  home: { publicKey: string }
  workspaceCoordinator: WorkspaceCoordinator
}

export async function memberTaskToHosted(selected: Target, openMember: typeof openMemberRuntime) {
  const f = selected.service
  const options = { headers: f.headers, throwOnError: true as const }
  const home = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: { ...f.identity, deviceID: "backup-handoff-source" },
    origin: f.origin,
  })
  const registration = await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: f.ca,
    ticket: await f.ticket(home.identity.deviceID, home.publicKey),
  })
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port
  await probe.stop(true)
  if (!port) throw new Error("The actual Member listener did not allocate its original port")
  const connected = Promise.withResolvers<void>()
  const sockets = new Set<unknown>()
  f.interceptFrames((socket, raw) => {
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID) sockets.add(socket)
    if (frame.type === "heartbeat" && sockets.has(socket)) connected.resolve()
    return false
  })
  let task: Awaited<ReturnType<typeof completedHostedTask>> | undefined
  try {
    await using runtime = await openMember({
      home: home.home,
      identity: home.identity,
      ca: f.ca,
      workspaceCoordinator: selected.workspaceCoordinator,
      handoff: true,
      listen: { port, token: "a".repeat(64) },
    })
    const timer = setTimeout(
      () => connected.reject(new Error("The original Member Handoff bridge did not connect")),
      5000,
    )
    try {
      await connected.promise
    } finally {
      clearTimeout(timer)
      f.interceptFrames(undefined)
    }
    await runtime.run(async () => {
      expect(ModelExecution.mode()).toBe("worker")
      await AgentTurn.prewarm()
      const workers = AgentTurn.stats()
      expect(workers.minIdle).toBeGreaterThan(0)
      expect(workers.ready).toBeGreaterThanOrEqual(workers.minIdle)
    })
    task = await completedHostedTask({ service: f, registration, runtime })
    const original = task
    const baseline = original.calls.length
    const owner = { kind: "session" as const, scopeID: original.info.scope.id, sessionID: original.sessionID }
    const originalRoot = await runtime.run(() =>
      MessageV2.get({ sessionID: original.sessionID, messageID: original.nativeRelease.rootID }),
    )
    const originalRun = await runtime.run(() => RolloutLedger.getRun(owner, original.nativeRelease.rootID))
    const originalCalls = await runtime.run(() => RolloutLedger.calls(owner, original.nativeRelease.rootID))
    expect(originalRoot.info.role).toBe("user")
    expect(originalRun).toMatchObject({
      id: original.accepted.effect.messageID,
      status: "completed",
      recording: "complete",
    })
    expect(await runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
    const inspected = Handoff.Options.parse(
      (
        await f.client.orgHandoff.options(
          {
            sessionID: original.sessionID,
            targetRuntimeID: selected.registration.runtimeID,
            requestID: "inspect-member-backup-destination",
          },
          options,
        )
      ).data,
    )
    if (inspected.source !== null || !inspected.environment || inspected.environment.source.kind === "organization")
      throw new Error(
        "This model-only Handoff requires its actual empty Workspace and native-or-none Environment inspection",
      )
    const environmentMapping = Handoff.EnvironmentMapping.parse({
      version: 1,
      expectedSelectionRevision: inspected.environment.expectedSelectionRevision,
      source: inspected.environment.source,
      target: { kind: "none" },
    })
    const prepared = (
      await f.client.orgHandoff.prepare(
        {
          sessionID: original.sessionID,
          orgHandoffPrepare: {
            handoffID: "actual-member-to-hosted-before-backup",
            targetRuntimeID: selected.registration.runtimeID,
            expectedBindingEpoch: inspected.bindingEpoch,
            expectedControlRevision: inspected.controlRevision,
            mappingPlanRevision: 1,
            workspaceMapping: { kind: "native" },
            environmentMapping,
          },
        },
        options,
      )
    ).data
    expect(prepared.targetAccepted).toBe(true)
    const binding = Handoff.Binding.strip().parse(prepared)
    const drive = createHandoffCompletion({
      binding,
      source: { runtimeID: registration.runtimeID, publicKey: home.publicKey },
      target: { runtimeID: selected.registration.runtimeID, publicKey: selected.home.publicKey },
      async invoke(operation, requestID) {
        return Handoff.MachineResult.parse(
          (
            await f.client.orgHandoff.drive(
              {
                handoffID: prepared.handoffID,
                orgHandoffDrive: { operation, requestID },
              },
              options,
            )
          ).data,
        )
      },
    })
    expect((await drive("prepare-source")).stage).toBe("source-frozen")
    expect((await drive("prepare-target")).stage).toBe("target-prepared")
    await f.client.orgHandoff.permit(
      { handoffID: prepared.handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
      options,
    )
    expect((await drive("surrender-source")).stage).toBe("source-surrendered")
    const committed = (await f.client.orgHandoff.commit({ handoffID: prepared.handoffID, body: {} }, options)).data
    expect(committed).toMatchObject({
      phase: "committed",
      currentDriver: selected.registration.runtimeID,
      bindingEpoch: binding.toEpoch,
    })
    await f.client.orgHandoff.permit(
      { handoffID: prepared.handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
      options,
    )
    expect((await drive("activate-target")).stage).toBe("target-activated")
    expect((await f.client.orgHandoff.get({ handoffID: prepared.handoffID }, options)).data).toMatchObject({
      phase: "completed",
      currentDriver: selected.registration.runtimeID,
      bindingEpoch: binding.toEpoch,
    })
    const nativeBinding = Epochs.Binding.parse({
      sessionID: original.sessionID,
      scopeID: original.info.scope.id,
      handoffID: prepared.handoffID,
      sourceID: registration.runtimeID,
      targetID: selected.registration.runtimeID,
      fromEpoch: binding.fromEpoch,
      toEpoch: binding.toEpoch,
    })
    expect(await runtime.run(() => Epochs.inspect(nativeBinding))).toMatchObject({
      role: "source",
      phase: "surrendered",
    })
    const info = await selected.runtime.run(() => Session.get(original.sessionID))
    expect(info).toMatchObject({
      id: original.sessionID,
      paused: expect.anything(),
      environmentID: null,
      organization: { driverRuntimeID: selected.registration.runtimeID, bindingEpoch: binding.toEpoch },
    })
    expect(
      await selected.runtime.run(() =>
        MessageV2.get({ sessionID: original.sessionID, messageID: original.nativeRelease.rootID }),
      ),
    ).toEqual(originalRoot)
    expect(await selected.runtime.run(() => RolloutLedger.getRun(owner, original.nativeRelease.rootID))).toEqual(
      originalRun,
    )
    expect(await selected.runtime.run(() => RolloutLedger.calls(owner, original.nativeRelease.rootID))).toEqual(
      originalCalls,
    )
    expect(await selected.runtime.run(() => RolloutLedger.tools(owner, original.nativeRelease.rootID))).toEqual([])
    expect(await selected.runtime.run(async () => SessionManager.isRunning(original.sessionID))).toBe(false)
    expect(await selected.runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
    expect(original.calls).toHaveLength(baseline)
    const serviceRecord = await f.service.maintenance.run(async () =>
      OrganizationHandoffRecord.RawStored.parse(await Storage.read(["organization", "handoffs", prepared.handoffID])),
    )
    const roster = await f.service.maintenance.run(async () => {
      const hosted = []
      for await (const row of Storage.records({ prefix: OrganizationStoragePath.runtimes(), limit: 128 })) {
        const runtime = OrganizationRecord.RuntimeRegistration.parse(row.value)
        if (runtime.runtimeKind === "hosted") hosted.push(runtime.runtimeID)
      }
      return hosted
    })
    expect(roster).toEqual([selected.registration.runtimeID])
    const targetEpoch = await selected.runtime.run(() => Epochs.inspect(nativeBinding))
    expect(targetEpoch).toMatchObject({ role: "target", phase: "activated" })
    return {
      ...original,
      info,
      handoffHistory: {
        handoffID: prepared.handoffID,
        serviceRecord,
        targetEpoch,
        inspectEpoch: () => Epochs.inspect(nativeBinding),
      },
    }
  } catch (error) {
    try {
      await task?.[Symbol.asyncDispose]()
    } catch (cleanup) {
      if (cleanup !== error)
        throw new AggregateError([error, cleanup], "Native Member Handoff and original task cleanup failed")
    }
    throw error
  } finally {
    f.interceptFrames(undefined)
  }
}
