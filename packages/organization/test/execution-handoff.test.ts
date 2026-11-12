import { expect, spyOn, test } from "bun:test"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationHandoffProtocol as Handoff,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationAuthorityHistory as History } from "../src/authority-history"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { createExecutionGrants } from "../src/execution-grants"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationExecutionIndex as Index } from "../src/execution-index"
import { executionFixture } from "./support/execution"
import { connection, keys } from "./support/runtime"

for (const mode of ["cancel", "transfer"] as const)
  for (const active of [false, true])
    test(`handoff ${mode} retains the original root through fresh control (active stream ${active})`, async () => {
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from("data: partial\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
        await f.connect(2, true, false, false, true)
        const targetKeys = await keys()
        const target = await f.run(async () => {
          const record = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
          const next = Record.RuntimeRegistration.parse({
            ...record,
            connectionEpoch: 0,
            publicKey: targetKeys.publicKey,
          })
          await Storage.write(Keys.runtime(next.runtimeID), next)
          History.register()
          registerHandoffAuthorityHistory()
          await History.initialize({
            schemaVersion: 1,
            orgID: "org",
            deploymentIncarnation: "deployment",
            createdAt: 1,
          })
          return next
        })
        const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
        try {
          await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve()
            socket.onerror = reject
          })
          const authorization = await connection(target, targetKeys.privateKey, 1)
          authorization.proof.handshake.capabilities.push("commands", "handoffs")
          authorization.proof.handshake.schemas.commands = 1
          authorization.proof.handshake.schemas.handoffs = 1
          authorization.signature = await Runtime.sign(authorization.proof, targetKeys.privateKey)
          const connected = Promise.withResolvers<unknown>()
          socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
          socket.send(JSON.stringify(authorization))
          Runtime.Connected.parse(await connected.promise)
          let response: Response | undefined
          if (active) {
            const proof = await f.proof("native-stream-before-freeze", { connectionEpoch: 2 })
            const permit = await f.run(() => f.gateway.calls.reserve(proof))
            response = await f.run(() =>
              f.gateway.models.invoke(
                new Request(new URL("/model", f.baseUrl), {
                  method: "POST",
                  headers: { "content-type": "application/json", authorization: `Bearer ${Gateway.encode(permit)}` },
                  body: JSON.stringify({ model: "fixture-model", messages: [] }),
                }),
                f.grant.selection.modelResourceID,
                "openai-compatible",
              ),
            )
          }
          const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
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
            await Index.migration.up(() => {})
            const view = await handoffs.prepare(f.credentials.alice, f.sessionID, {
              handoffID: "paused-source-generation",
              targetRuntimeID: target.runtimeID,
              expectedBindingEpoch: 1,
              expectedControlRevision: 0,
              mappingPlanRevision: 1,
            })
            await handoffs.accept(f.credentials.bob, view.handoffID, { mappingPlanRevision: 1 })
            const tuple = {
              schemaVersion: 1 as const,
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
            }
            const frozen = Handoff.Proof.parse({
              ...tuple,
              purpose: "source-frozen",
              manifestHash: "a".repeat(64),
              commandSeq: view.commandSeq,
              receivedSeq: view.commandSeq,
              compatibilityHash: "b".repeat(64),
              closureHash: "c".repeat(64),
              fileClosureHash: null,
              workspaceMoveReceiptHash: null,
              paused: true,
              drained: true,
            })
            const prepared = Handoff.Proof.parse({
              ...tuple,
              purpose: "target-prepared",
              manifestHash: "a".repeat(64),
              compatibilityHash: "b".repeat(64),
              convertedHash: "d".repeat(64),
              closureHash: "c".repeat(64),
              fileClosureHash: null,
              workspaceMoveReceiptHash: null,
              paused: true,
            })
            await handoffs.proof({
              proof: frozen,
              signature: await Handoff.signProof(frozen, f.machineKeys.privateKey),
            })
            const proof = Execution.HandoffCloseProof.parse({
              ...tuple,
              purpose: "execution-handoff-close",
              runtimeID: f.grant.runtimeID,
              connectionEpoch: 2,
              grantID: f.grant.grantID,
              rootID: f.grant.rootID,
              generation: f.grant.retention.generation,
              manifestHash: "a".repeat(64),
              preparedHash: await Handoff.proofHash(prepared),
              receipt: f.binding.proof.receipt,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 15_000,
            })
            const signed = { proof, signature: await Execution.signHandoffClose(proof, f.machineKeys.privateKey) }
            await expect(execution.closeHandoff(signed)).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
            expect(
              (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
            ).toBe(1)
            await handoffs.proof({
              proof: prepared,
              signature: await Handoff.signProof(prepared, targetKeys.privateKey),
            })
            const inventory = Execution.HandoffInventoryProof.parse({
              ...tuple,
              purpose: "execution-handoff-inventory",
              runtimeID: f.grant.runtimeID,
              connectionEpoch: 2,
              manifestHash: proof.manifestHash,
              preparedHash: proof.preparedHash,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 15_000,
            })
            expect(
              await execution.handoffInventory({
                proof: inventory,
                signature: await Execution.signHandoffInventory(inventory, f.machineKeys.privateKey),
              }),
            ).toMatchObject({
              retained: 1,
              items: [
                {
                  grantID: f.grant.grantID,
                  rootID: f.grant.rootID,
                  generation: 1,
                  originGrantID: f.grant.grantID,
                  lookup: { subjectID: f.grant.actor.subjectID, requestID: f.grant.actor.requestID },
                },
              ],
            })
            for (const change of [
              { grantID: "another-grant" },
              { generation: 2 },
              { preparedHash: "e".repeat(64) },
              { toEpoch: 3 },
              { shareGeneration: 2 },
            ]) {
              const altered = Execution.HandoffCloseProof.parse({ ...proof, ...change })
              await expect(
                execution.closeHandoff({
                  proof: altered,
                  signature: await Execution.signHandoffClose(altered, f.machineKeys.privateKey),
                }),
              ).rejects.toThrow()
              expect(
                (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
              ).toBe(1)
            }
            if (response) {
              await expect(execution.closeHandoff(signed)).rejects.toMatchObject({
                data: { code: "RESOURCE_UNAVAILABLE" },
              })
              expect(
                (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
              ).toBe(1)
              await response.body!.cancel()
            }
            if (mode === "cancel" && !active) {
              const write = Storage.write
              const fault = spyOn(Storage, "write").mockImplementation(async (key, value) => {
                await write(key, value)
                if (key[1] === "execution-handoff-closures")
                  throw new Error("Fail after the actual close receipt write")
              })
              try {
                await expect(execution.closeHandoff(signed)).rejects.toThrow("actual close receipt")
              } finally {
                fault.mockRestore()
              }
              expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toMatchObject({
                retention: { state: "held", generation: 1 },
              })
              expect(
                (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
              ).toBe(1)
              expect(
                await execution.handoffInventory({
                  proof: inventory,
                  signature: await Execution.signHandoffInventory(inventory, f.machineKeys.privateKey),
                }),
              ).toMatchObject({ retained: 1, items: [{ grantID: f.grant.grantID }] })
            }
            const receipt = await execution.closeHandoff(signed)
            expect(receipt).toMatchObject({
              handoffID: view.handoffID,
              grantID: f.grant.grantID,
              rootID: f.grant.rootID,
              generation: 1,
            })
            expect(receipt).not.toHaveProperty("outcome")
            expect(await execution.closeHandoff(signed)).toEqual(receipt)
            const retained = await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))
            expect(retained).toMatchObject({
              actor: f.grant.actor,
              rootID: f.grant.rootID,
              runtimeID: f.grant.runtimeID,
              bindingEpoch: 1,
              retention: { state: "handoff_closed", handoffID: view.handoffID, generation: 1 },
            })
            expect(
              (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
            ).toBe(0)
            expect(await Storage.readMany([Keys.executionRelease(f.grant.grantID, 1)])).toEqual([undefined])
            await expect(f.execution.bind(f.binding)).rejects.toThrow()
            if (mode === "cancel") {
              await handoffs.cancel(f.credentials.alice, view.handoffID)
              const cancelled = Handoff.Proof.parse({
                ...tuple,
                purpose: "source-cancelled",
                manifestHash: proof.manifestHash,
                gateCancelled: true,
                paused: true,
              })
              await handoffs.proof({
                proof: cancelled,
                signature: await Handoff.signProof(cancelled, f.machineKeys.privateKey),
              })
            } else {
              const surrender = await handoffs.permit(f.credentials.alice, view.handoffID, {
                purpose: "handoff-surrender",
              })
              const surrendered = Handoff.Proof.parse({
                ...tuple,
                purpose: "source-surrendered",
                manifestHash: proof.manifestHash,
                permitID: surrender.permit.permitID,
                preparedHash: proof.preparedHash,
                gatePersisted: true,
              })
              await handoffs.proof({
                proof: surrendered,
                signature: await Handoff.signProof(surrendered, f.machineKeys.privateKey),
              })
              await handoffs.commit(f.credentials.alice, view.handoffID)
              const activation = await handoffs.permit(f.credentials.bob, view.handoffID, {
                purpose: "handoff-activation",
              })
              const activated = Handoff.Proof.parse({
                ...tuple,
                purpose: "target-activated",
                manifestHash: proof.manifestHash,
                permitID: activation.permit.permitID,
                preparedHash: proof.preparedHash,
                paused: true,
              })
              await handoffs.proof({
                proof: activated,
                signature: await Handoff.signProof(activated, targetKeys.privateKey),
              })
            }
            const currentRuntimeID = mode === "cancel" ? f.grant.runtimeID : target.runtimeID
            const currentEpoch = mode === "cancel" ? 1 : view.toEpoch
            const currentConnectionEpoch = mode === "cancel" ? 2 : 1
            const currentKey = mode === "cancel" ? f.machineKeys.privateKey : targetKeys.privateKey
            const original = Execution.BindingProof.parse({
              ...f.binding.proof,
              connectionEpoch: 2,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 15_000,
            })
            await expect(
              execution.bind({
                proof: original,
                signature: await Execution.signBinding(original, f.machineKeys.privateKey),
              }),
            ).rejects.toMatchObject({
              data: { code: mode === "cancel" ? "HANDOFF_BLOCKED" : "STALE_BINDING" },
            })
            expect(await execution.closeHandoff(signed)).toEqual(receipt)
            expect(
              (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
            ).toBe(0)
            const control: Command.Control = { operation: "continue", pausedSince: 10, controlVersion: 0 }
            const admitted = await f.commands.control(
              f.credentials.bob,
              Command.ControlRequest.parse({
                schemaVersion: 1,
                orgID: "org",
                sessionID: f.sessionID,
                projectID: "project",
                runtimeID: currentRuntimeID,
                requestID: "independent-source-continue",
                control,
              }),
            )
            if (admitted.kind !== "admitted") throw new Error("Expected a fresh independent control")
            const permit = admitted.delivery.authorization.permit
            const continued = Command.ControlResult.parse({
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
                  pausedSince: 10,
                  itemID: "inb_resume_original",
                  messageID: "msg_resume_original",
                  rootID: f.grant.rootID,
                },
              },
            })
            const { rootID: _, purpose: __, ...prior } = original
            const description = Execution.DescriptionProof.parse({
              ...prior,
              runtimeID: currentRuntimeID,
              connectionEpoch: currentConnectionEpoch,
              purpose: "execution-resource-description",
              continuation: { handoffID: view.handoffID, receipt: continued },
            })
            const fresh = await execution.describe({
              proof: description,
              signature: await Execution.signDescription(description, currentKey),
            })
            expect(fresh.grant.grantID).not.toBe(f.grant.grantID)
            expect(fresh.grant).toMatchObject({
              actor: f.grant.actor,
              runtimeID: currentRuntimeID,
              bindingEpoch: currentEpoch,
              provenance: {
                handoffID: view.handoffID,
                predecessorGrantID: f.grant.grantID,
                originGrantID: f.grant.grantID,
                control: continued.accepted,
              },
            })
            const rebound = Execution.BindingProof.parse({
              ...description,
              purpose: "execution-root-binding",
              rootID: f.grant.rootID,
            })
            const bound = await execution.bind({
              proof: rebound,
              signature: await Execution.signBinding(rebound, currentKey),
            })
            expect(bound).toMatchObject({
              grantID: fresh.grant.grantID,
              rootID: f.grant.rootID,
              retention: { state: "held", generation: 1 },
            })
            expect(
              (
                await execution.describe({
                  proof: description,
                  signature: await Execution.signDescription(description, currentKey),
                })
              ).grant.grantID,
            ).toBe(bound.grantID)
            const releaseProof = {
              ...description,
              purpose: "execution-resources-release",
              rootID: bound.rootID,
              generation: bound.retention.generation,
              outcome: "completed",
              materialized: true,
            }
            expect(Execution.ReleaseProof.safeParse(releaseProof).success).toBeFalse()
            const wrongRelease = Execution.ReleaseProof.parse({ ...releaseProof, grantID: f.grant.grantID })
            await expect(
              execution.release({
                proof: wrongRelease,
                signature: await Execution.signRelease(wrongRelease, currentKey),
              }),
            ).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
            const directory = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
            const next = await handoffs.prepare(
              mode === "cancel" ? f.credentials.alice : f.credentials.bob,
              f.sessionID,
              {
                handoffID: "cancel-with-retained-source",
                targetRuntimeID: mode === "cancel" ? target.runtimeID : f.grant.runtimeID,
                expectedBindingEpoch: directory.bindingEpoch,
                expectedControlRevision: directory.controlRevision,
                mappingPlanRevision: 1,
              },
            )
            await handoffs.cancel(mode === "cancel" ? f.credentials.alice : f.credentials.bob, next.handoffID)
            const noClose = Handoff.Proof.parse({
              ...tuple,
              sourceRuntimeID: currentRuntimeID,
              targetRuntimeID: mode === "cancel" ? target.runtimeID : f.grant.runtimeID,
              fromEpoch: currentEpoch,
              handoffID: next.handoffID,
              toEpoch: next.toEpoch,
              purpose: "source-cancelled",
              manifestHash: null,
              gateCancelled: true,
              paused: true,
            })
            await handoffs.proof({ proof: noClose, signature: await Handoff.signProof(noClose, currentKey) })
            await expect(
              execution.describe({
                proof: description,
                signature: await Execution.signDescription(description, currentKey),
              }),
            ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
            const again = await f.commands.control(
              f.credentials.alice,
              Command.ControlRequest.parse({
                schemaVersion: 1,
                orgID: "org",
                sessionID: f.sessionID,
                projectID: "project",
                runtimeID: currentRuntimeID,
                requestID: "resume-retained-root",
                control: { operation: "continue", pausedSince: 20, controlVersion: 1 },
              }),
            )
            if (again.kind !== "admitted") throw new Error("Expected a second explicit control")
            const nextPermit = again.delivery.authorization.permit
            const nextControl = Command.ControlResult.parse({
              attempt: {
                schemaVersion: 1,
                permit: nextPermit,
                receivedAt: Date.now(),
                status: "accepted",
                acceptedAttemptID: nextPermit.attemptID,
              },
              accepted: {
                schemaVersion: 1,
                permit: nextPermit,
                acceptedAt: Date.now(),
                intakeSeq: 3,
                effect: {
                  kind: "control",
                  operation: "continue",
                  controlVersion: 2,
                  pausedSince: 20,
                  itemID: "inb_resume_retained",
                  messageID: "msg_resume_retained",
                  rootID: f.grant.rootID,
                },
              },
            })
            const nextDescription = Execution.DescriptionProof.parse({
              ...description,
              continuation: { handoffID: next.handoffID, receipt: nextControl },
            })
            const second = await execution.describe({
              proof: nextDescription,
              signature: await Execution.signDescription(nextDescription, currentKey),
            })
            expect(second.grant.grantID).not.toBe(bound.grantID)
            expect(second.grant).toMatchObject({
              actor: f.grant.actor,
              provenance: {
                predecessorGrantID: bound.grantID,
                originGrantID: f.grant.grantID,
                control: nextControl.accepted,
              },
            })
            expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(bound.grantID))).toMatchObject({
              retention: { state: "control_closed", successorGrantID: second.grant.grantID },
            })
            expect(
              (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants,
            ).toBe(1)
            if (mode === "transfer" && !active) {
              const directory = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
              const third = await handoffs.prepare(f.credentials.bob, f.sessionID, {
                handoffID: "successor-replay-proof",
                targetRuntimeID: f.grant.runtimeID,
                expectedBindingEpoch: directory.bindingEpoch,
                expectedControlRevision: directory.controlRevision,
                mappingPlanRevision: 1,
              })
              await handoffs.accept(f.credentials.alice, third.handoffID, { mappingPlanRevision: 1 })
              const exact = {
                ...tuple,
                handoffID: third.handoffID,
                sourceRuntimeID: currentRuntimeID,
                targetRuntimeID: f.grant.runtimeID,
                fromEpoch: currentEpoch,
                toEpoch: third.toEpoch,
              }
              const sealed = Handoff.Proof.parse({
                ...exact,
                purpose: "source-frozen",
                manifestHash: "7".repeat(64),
                commandSeq: third.commandSeq,
                receivedSeq: third.commandSeq,
                compatibilityHash: "8".repeat(64),
                closureHash: "9".repeat(64),
                fileClosureHash: null,
                workspaceMoveReceiptHash: null,
                paused: true,
                drained: true,
              })
              if (sealed.purpose !== "source-frozen") throw new Error("Expected the actual frozen source fact")
              const installed = Handoff.Proof.parse({
                ...exact,
                purpose: "target-prepared",
                manifestHash: sealed.manifestHash,
                compatibilityHash: sealed.compatibilityHash,
                closureHash: sealed.closureHash,
                convertedHash: "6".repeat(64),
                fileClosureHash: null,
                workspaceMoveReceiptHash: null,
                paused: true,
              })
              await handoffs.proof({ proof: sealed, signature: await Handoff.signProof(sealed, currentKey) })
              await handoffs.proof({
                proof: installed,
                signature: await Handoff.signProof(installed, f.machineKeys.privateKey),
              })
              const closure = Execution.HandoffCloseProof.parse({
                ...exact,
                purpose: "execution-handoff-close",
                runtimeID: currentRuntimeID,
                connectionEpoch: currentConnectionEpoch,
                grantID: second.grant.grantID,
                rootID: f.grant.rootID,
                generation: 0,
                manifestHash: sealed.manifestHash,
                preparedHash: await Handoff.proofHash(installed),
                receipt: f.binding.proof.receipt,
                continuation: nextDescription.continuation,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 15_000,
              })
              const closed = await execution.closeHandoff({
                proof: closure,
                signature: await Execution.signHandoffClose(closure, currentKey),
              })
              const tampered = structuredClone(closure)
              tampered.receipt.accepted!.effect.itemID = "invented-original-reception"
              await expect(
                execution.closeHandoff({
                  proof: tampered,
                  signature: await Execution.signHandoffClose(tampered, currentKey),
                }),
              ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
              const wrongControl = Execution.HandoffCloseProof.parse({
                ...closure,
                continuation: { ...closure.continuation!, receipt: continued },
              })
              await expect(
                execution.closeHandoff({
                  proof: wrongControl,
                  signature: await Execution.signHandoffClose(wrongControl, currentKey),
                }),
              ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
              expect(
                await execution.closeHandoff({
                  proof: closure,
                  signature: await Execution.signHandoffClose(closure, currentKey),
                }),
              ).toEqual(closed)
            }
          })
        } finally {
          socket.close()
        }
      } finally {
        await upstream.stop(true)
      }
    }, 15000)
