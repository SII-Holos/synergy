import { expect, test } from "bun:test"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
  OrganizationHandoffProtocol as Handoff,
  OrganizationExecutionProtocol as Execution,
  OrganizationCommandProtocol as Command,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationAuthorityHistory as History } from "../src/authority-history"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { createHandoffs, registerHandoffAuthorityHistory, OrganizationHandoffExecution } from "../src/handoff"
import { createExecutionGrants } from "../src/execution-grants"
import { OrganizationSharing } from "../src/sharing"
import { executionFixture } from "./support/execution"
import { connection, keys } from "./support/runtime"

for (const cleanup of [false, true])
  test(`cancelling the first handoff fences retained source use until independent control (terminal cleanup ${cleanup})`, async () => {
    let dispatches = 0
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        dispatches++
        return Response.json({ answer: "new task" })
      },
    })
    await using upstreamOwner = {
      async [Symbol.asyncDispose]() {
        await upstream.stop(true)
      },
    }
    await using f = await executionFixture({
      endpoint: new URL("/v1", upstream.url).href,
      sync: { receipt: (lease, query) => handoffs.syncBatchReceipt(lease, query) },
    })
    const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
    await f.connect(2, true, false, false, true, Handoff.syncTransferBridge)
    const targetKeys = await keys()
    const target = await f.run(async () => {
      const record = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
      const next = Record.RuntimeRegistration.parse({ ...record, connectionEpoch: 0, publicKey: targetKeys.publicKey })
      await Storage.write(Keys.runtime(next.runtimeID), next)
      History.register()
      registerHandoffAuthorityHistory()
      await History.initialize({ schemaVersion: 1, orgID: "org", deploymentIncarnation: "deployment", createdAt: 1 })
      return next
    })
    const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = reject
      })
      const authorization = await connection(target, targetKeys.privateKey, 1)
      authorization.proof.handshake.capabilities.push("commands", "handoffs", "sync")
      authorization.proof.handshake.schemas.commands = 1
      authorization.proof.handshake.schemas.handoffs = Handoff.syncTransferBridge
      authorization.proof.handshake.schemas.sync = Sync.observationVersion
      authorization.signature = await Runtime.sign(authorization.proof, targetKeys.privateKey)
      const connected = Promise.withResolvers<unknown>()
      socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
      socket.send(JSON.stringify(authorization))
      Runtime.Connected.parse(await connected.promise)
      const execution = createExecutionGrants({
        connections: f.connections,
        admissions: f.commands,
        handoffs,
        assertResourcesDrained(grantID) {
          f.gateway.models.assertDrained(grantID)
          f.gateway.connections.assertDrained(grantID)
        },
      })
      await f.run(async () => {
        await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
        const capability = await f.gateway.calls.reserve(await f.proof("before-first-cancel", { connectionEpoch: 2 }))
        const view = await handoffs.prepare(f.credentials.alice, f.sessionID, {
          handoffID: "first-retained-cancel",
          targetRuntimeID: target.runtimeID,
          expectedBindingEpoch: 1,
          expectedControlRevision: 0,
          mappingPlanRevision: 1,
        })
        await handoffs.cancel(f.credentials.alice, view.handoffID)
        const cancelled = Handoff.Proof.parse({
          schemaVersion: 1,
          orgID: "org",
          deploymentIncarnation: "deployment",
          handoffID: view.handoffID,
          sessionID: f.sessionID,
          sourceRuntimeID: f.grant.runtimeID,
          targetRuntimeID: target.runtimeID,
          fromEpoch: 1,
          toEpoch: view.toEpoch,
          mappingPlanRevision: 1,
          shareGeneration: 1,
          purpose: "source-cancelled",
          manifestHash: null,
          gateCancelled: true,
          paused: true,
        })
        await handoffs.proof({
          proof: cancelled,
          signature: await Handoff.signProof(cancelled, f.machineKeys.privateKey),
        })
        const old = Execution.BindingProof.parse({
          ...f.binding.proof,
          connectionEpoch: 2,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 15_000,
        })
        await expect(
          execution.bind({ proof: old, signature: await Execution.signBinding(old, f.machineKeys.privateKey) }),
        ).rejects.toThrow()
        await expect(
          f.gateway.calls.reserve(await f.proof("after-first-cancel", { connectionEpoch: 2 })),
        ).rejects.toThrow()
        await expect(f.gateway.calls.authorize(capability)).rejects.toThrow()
        await expect(
          f.gateway.models.invoke(
            new Request(new URL("/model", f.baseUrl), {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${Gateway.encode(capability)}` },
              body: JSON.stringify({ model: "fixture-model", messages: [] }),
            }),
            f.grant.selection.modelResourceID,
            "openai-compatible",
          ),
        ).rejects.toThrow()
        expect(dispatches).toBe(0)
        const description = Execution.DescriptionProof.parse({
          schemaVersion: 1,
          purpose: "execution-resource-description",
          orgID: old.orgID,
          deploymentIncarnation: old.deploymentIncarnation,
          runtimeID: old.runtimeID,
          connectionEpoch: old.connectionEpoch,
          receipt: old.receipt,
          issuedAt: old.issuedAt,
          expiresAt: old.expiresAt,
        })
        expect(
          await execution.retention({
            proof: description,
            signature: await Execution.signDescription(description, f.machineKeys.privateKey),
          }),
        ).toMatchObject({ grantID: f.grant.grantID, retention: { state: "held", generation: 1 } })
        expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toMatchObject({
          retention: { state: "held", generation: 1 },
        })
        await Storage.removeTree(["organization", "session-handoff-epochs"])
        await expect(
          execution.bind({ proof: old, signature: await Execution.signBinding(old, f.machineKeys.privateKey) }),
        ).rejects.toThrow("owning migration")
        await OrganizationHandoffExecution.migration.up(() => {})
        await expect(
          execution.bind({ proof: old, signature: await Execution.signBinding(old, f.machineKeys.privateKey) }),
        ).rejects.toThrow("independently accepted")
        if (cleanup) {
          const terminal = Execution.ReleaseProof.parse({
            ...old,
            purpose: "execution-resources-release",
            grantID: f.grant.grantID,
            generation: 1,
            outcome: "completed",
          })
          expect(
            await execution.release({
              proof: terminal,
              signature: await Execution.signRelease(terminal, f.machineKeys.privateKey),
            }),
          ).toMatchObject({ grantID: f.grant.grantID, generation: 1, outcome: "completed" })
        }
        const control: Command.Control = { operation: "continue", pausedSince: 1, controlVersion: 0 }
        const admitted = await f.commands.control(
          f.credentials.alice,
          Command.ControlRequest.parse({
            schemaVersion: 1,
            orgID: "org",
            sessionID: f.sessionID,
            projectID: "project",
            runtimeID: f.grant.runtimeID,
            requestID: "fresh-control-after-retained-cancel",
            control,
          }),
        )
        if (admitted.kind !== "admitted") throw new Error("Expected independent Continue admission")
        const permit = admitted.delivery.authorization.permit
        const received = Command.ControlResult.parse({
          attempt: {
            schemaVersion: 1,
            permit,
            receivedAt: Date.now(),
            status: "accepted",
            acceptedAttemptID: permit.attemptID,
          },
          accepted: {
            schemaVersion: 1,
            permit,
            acceptedAt: Date.now(),
            intakeSeq: 2,
            effect: {
              kind: "control",
              operation: "continue",
              controlVersion: 1,
              pausedSince: 1,
              itemID: "inb_fresh_continue",
              messageID: "msg_fresh_continue",
              rootID: f.grant.rootID,
            },
          },
        })
        const current = Execution.BindingProof.parse({
          ...old,
          continuation: { handoffID: view.handoffID, receipt: received },
        })
        const renewed = await execution.bind({
          proof: current,
          signature: await Execution.signBinding(current, f.machineKeys.privateKey),
        })
        expect(renewed).toMatchObject({
          rootID: f.grant.rootID,
          actor: f.grant.actor,
          provenance: { originGrantID: f.grant.grantID, control: received.accepted },
        })
        expect(renewed.grantID).not.toBe(f.grant.grantID)
        const ordinary = f.request()
        ordinary.requestID = "ordinary-task-after-cancel"
        ordinary.input.mode = "task"
        const task = await f.commands.input(f.credentials.alice, ordinary)
        if (task.kind !== "admitted") throw new Error("Expected a genuinely new task after the barrier")
        const next = task.delivery.authorization.permit
        const taskReceipt = Command.InputResult.parse({
          attempt: {
            schemaVersion: 1,
            permit: next,
            receivedAt: Date.now(),
            status: "accepted",
            acceptedAttemptID: next.attemptID,
          },
          accepted: {
            schemaVersion: 1,
            permit: next,
            acceptedAt: Date.now(),
            intakeSeq: 3,
            effect: { kind: "inbox", mode: "task", itemID: "inb_new_task", messageID: "msg_new_task" },
          },
        })
        const newProof = Execution.BindingProof.parse({ ...old, rootID: "msg_new_task", receipt: taskReceipt })
        const newGrant = await execution.bind({
          proof: newProof,
          signature: await Execution.signBinding(newProof, f.machineKeys.privateKey),
        })
        expect(newGrant.provenance).toBeUndefined()
        const invocation = (await f.proof("ordinary-task-after-cancel", { connectionEpoch: 2 })).proof
        invocation.grantID = newGrant.grantID
        invocation.rootID = newGrant.rootID
        const newCapability = await f.gateway.calls.reserve({
          proof: invocation,
          signature: await Gateway.signRequest(invocation, f.machineKeys.privateKey),
        })
        const response = await f.gateway.models.invoke(
          new Request(new URL("/model", f.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${Gateway.encode(newCapability)}` },
            body: JSON.stringify({ model: "fixture-model", messages: [] }),
          }),
          newGrant.selection.modelResourceID,
          "openai-compatible",
        )
        await response.text()
        expect(dispatches).toBe(1)
      })
    } finally {
      socket.close()
    }
  })
