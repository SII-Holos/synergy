import { expect, spyOn, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationHandoffProtocol as Handoff,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferEpochs as Epochs,
  SessionTransferStaging as Staging,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { createCommandIntake } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationSessionAdoption as Adoption } from "../src/session-adoption"

test.each(["source-cancel", "target-activate"] as const)(
  "an independent Continue after %s retains its control alongside the original native task",
  async (mode) => {
    const binding = {
      schemaVersion: 1 as const,
      orgID: "continuation-org",
      projectID: "continuation-project",
      creatorID: "original-author",
      driverRuntimeID: "source-runtime",
      bindingEpoch: 1,
    }
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const identity = {
      schemaVersion: 1 as const,
      orgID: binding.orgID,
      deploymentIncarnation: "continuation-deployment",
      keyID: "service-key",
      publicKey: await Runtime.publicKey(keys.publicKey),
    }
    await using runtime = await testRuntime({
      register() {
        Core.register()
        registerSessionSchema(binding)
        registerOrganizationTransferOwner()
      },
    })
    await runtime.run(async () => {
      using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
      const scope = await Scope.registerProject({
        type: "project",
        id: binding.projectID,
        local: null,
        time: { created: 1, updated: 1 },
      })
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          const native = await Session.create({ organization: binding, workspaceID: null, environmentID: null })
          await Session.update(native.id, (draft) => {
            draft.modelOverride = { providerID: "test", modelID: "test" }
          })
          const intake = createCommandIntake({
            identity,
            runtimeID: binding.driverRuntimeID,
            accountID: binding.creatorID,
            connectionEpoch: 1,
            signal: new AbortController().signal,
          })
          const input: Command.Input = {
            operation: "input",
            mode: "task",
            parts: [{ type: "text", text: "Keep this original task" }],
          }
          const permit = Command.Permit.parse({
            schemaVersion: 1,
            purpose: "session-command",
            deploymentIncarnation: identity.deploymentIncarnation,
            keyID: identity.keyID,
            orgID: binding.orgID,
            sessionID: native.id,
            projectID: binding.projectID,
            runtimeID: binding.driverRuntimeID,
            bindingEpoch: 1,
            connectionEpoch: 1,
            commandSeq: 1,
            shareGeneration: 0,
            controlRevision: 0,
            authRevision: 1,
            requestID: "original-task",
            admissionID: "original-admission",
            attemptID: "original-attempt",
            operation: "input",
            actor: {
              kind: "account",
              orgID: binding.orgID,
              subjectID: binding.creatorID,
              displayName: "Original author",
              clientKind: "web",
              requestID: "original-task",
            },
            authorizedAt: Date.now(),
            deadline: Date.now() + 30_000,
            provisionalGrantID: "original-grant",
            payloadHash: "0".repeat(64),
          })
          permit.payloadHash = await Command.digestInput(Command.inputRequest(permit, input))
          const received = await intake.input({
            authorization: { permit, signature: await Command.sign(permit, keys.privateKey) },
            input,
          })
          const accepted = received.accepted!
          expect((await SessionInbox.materializeNextTask(native.id)).status).toBe("materialized")
          await RolloutLedger.beginRun(RolloutLifecycle.owner(native), accepted.effect.messageID)
          const values = new Map<string, Uint8Array>()
          const transfer = {
            sessionID: native.id,
            scopeID: scope.id,
            handoffID: "cancelled-source-handoff",
            sourceID: binding.driverRuntimeID,
            targetID: "target-runtime",
            fromEpoch: 1,
            toEpoch: 2,
          }
          const store = {
            async put(hash: string, bytes: Uint8Array) {
              values.set(hash, bytes.slice())
            },
            async get(hash: string, maximum: number) {
              const value = values.get(hash)
              if (!value || value.length > maximum) throw new Error("Missing frame")
              return value.slice()
            },
          }
          const prepared = await Source.prepare({
            binding: transfer,
            signal: new AbortController().signal,
            async verify() {},
            store,
          })
          const tuple = Handoff.Binding.parse({
            schemaVersion: 1,
            orgID: binding.orgID,
            deploymentIncarnation: identity.deploymentIncarnation,
            handoffID: transfer.handoffID,
            sessionID: native.id,
            sourceRuntimeID: transfer.sourceID,
            targetRuntimeID: transfer.targetID,
            fromEpoch: 1,
            toEpoch: 2,
            mappingPlanRevision: 1,
            shareGeneration: 0,
          })
          const surrenderPermit = Handoff.Permit.parse({
            ...tuple,
            purpose: "handoff-surrender",
            permitID: "close-source-resources",
            keyID: identity.keyID,
            sourceBinding: binding,
            manifestHash: prepared.manifestHash,
            preparedHash: "3".repeat(64),
            createdAt: Date.now(),
          })
          const plan = Handoff.MachinePlan.parse({
            ...tuple,
            purpose: "handoff-machine",
            requestID: "close-source-resources",
            keyID: identity.keyID,
            runtimeID: binding.driverRuntimeID,
            connectionEpoch: 1,
            operation: "surrender-source",
            sourceBinding: binding,
            commandSeq: 1,
            controlRevision: 0,
            authRevision: 1,
            actor: { ...permit.actor, requestID: "close-source-resources" },
            manifestHash: prepared.manifestHash,
            preparedHash: surrenderPermit.preparedHash,
            authorization: {
              permit: surrenderPermit,
              signature: await Handoff.signPermit(surrenderPermit, keys.privateKey),
            },
            issuedAt: Date.now(),
            expiresAt: Date.now() + 30_000,
          })
          const authorization = { plan, signature: await Handoff.signMachinePlan(plan, keys.privateKey) }
          const item = Execution.HandoffInventoryItem.parse({
            grantID: permit.provisionalGrantID,
            rootID: accepted.effect.messageID,
            generation: 1,
            originGrantID: permit.provisionalGrantID,
            lookup: { subjectID: permit.actor.subjectID, requestID: permit.requestID },
          })
          expect(await intake.handoffCloseProof({ authorization, item })).toMatchObject({
            ...tuple,
            grantID: item.grantID,
            rootID: item.rootID,
            receipt: { accepted },
          })
          for (const changed of [
            { rootID: "foreign-root" },
            { originGrantID: "foreign-grant" },
            { grantID: "unproven-successor" },
          ]) {
            await expect(intake.handoffCloseProof({ authorization, item: { ...item, ...changed } })).rejects.toThrow()
          }
          async function continueOwned(driverRuntimeID: string, epoch: number) {
            const receiver = createCommandIntake({
              identity,
              runtimeID: driverRuntimeID,
              accountID: driverRuntimeID === binding.driverRuntimeID ? binding.creatorID : "current-controller",
              connectionEpoch: 1,
              signal: new AbortController().signal,
            })
            const pausedSince = (await Session.get(native.id)).paused!.since
            const control: Command.Control = { operation: "continue", pausedSince, controlVersion: 0 }
            const continuation = Command.Permit.parse({
              ...permit,
              runtimeID: driverRuntimeID,
              bindingEpoch: epoch,
              requestID: "continue-original",
              admissionID: "continue-admission",
              attemptID: "continue-attempt",
              operation: "continue",
              commandSeq: 2,
              provisionalGrantID: undefined,
              actor: {
                ...permit.actor,
                subjectID: "current-controller",
                displayName: "Current controller",
                requestID: "continue-original",
              },
            })
            continuation.payloadHash = await Command.digestControl(Command.controlRequest(continuation, control))
            const continued = await receiver.control({
              authorization: { permit: continuation, signature: await Command.sign(continuation, keys.privateKey) },
              control,
            })
            expect(continued.accepted?.effect).toMatchObject({
              operation: "continue",
              rootID: accepted.effect.messageID,
            })
            const controlReceipt = Command.ControlResult.parse(JSON.parse(JSON.stringify(continued)))
            const lookup = { subjectID: permit.actor.subjectID, requestID: permit.requestID }
            const description = await receiver.descriptionProof(lookup)
            expect(description).toMatchObject({
              receipt: { accepted },
              continuation: { handoffID: transfer.handoffID, receipt: controlReceipt },
            })
            const rootProof = await receiver.bindingProof(lookup, accepted.effect.messageID)
            expect(rootProof).toMatchObject({
              rootID: accepted.effect.messageID,
              receipt: { accepted },
              continuation: { handoffID: transfer.handoffID, receipt: controlReceipt },
            })
            expect(
              (
                await MessageV2.readInfo({
                  scopeID: scope.id,
                  sessionID: native.id,
                  messageID: accepted.effect.messageID,
                })
              ).actor,
            ).toEqual(permit.actor)
            expect((await Session.get(native.id)).resume?.actor).toEqual(continuation.actor)
          }
          if (mode === "source-cancel") {
            await Source.cancel({ binding: transfer, store, signal: new AbortController().signal, async verify() {} })
            await continueOwned(binding.driverRuntimeID, 1)
          } else {
            const sourceSession = await Session.get(native.id)
            const preparedHash = "b".repeat(64)
            await Source.surrender({
              binding: transfer,
              manifestHash: prepared.manifestHash,
              preparedHash,
              signal: new AbortController().signal,
              async verify() {},
            })
            await using target = await testRuntime({
              register() {
                Core.register()
                registerSessionSchema(binding)
                registerOrganizationTransferOwner()
              },
            })
            await target.run(() =>
              ScopeContext.provide({
                scope,
                workspace: null,
                fn: async () => {
                  const signal = new AbortController().signal
                  await Staging.receive({ handoffID: transfer.handoffID, root: prepared.root, store, signal })
                  const contexts: { ownerID: string; context: Owners.TargetContext }[] = []
                  for (const ownerID of ["session-core", "organization-runtime"]) {
                    const context = await Staging.context({
                      handoffID: transfer.handoffID,
                      ownerID,
                      session: sourceSession,
                      rootSessionID: native.id,
                      mapping: { workspaceIDs: {}, environmentID: null },
                      signal,
                    })
                    await Owners.validate(ownerID, context)
                    contexts.push({ ownerID, context })
                  }
                  await Epochs.reserve(transfer, prepared.manifestHash)
                  const permit = Handoff.Permit.parse({
                    schemaVersion: 1,
                    purpose: "handoff-activation",
                    orgID: binding.orgID,
                    deploymentIncarnation: identity.deploymentIncarnation,
                    keyID: identity.keyID,
                    permitID: "native-target-activation",
                    handoffID: transfer.handoffID,
                    sessionID: native.id,
                    sourceRuntimeID: transfer.sourceID,
                    targetRuntimeID: transfer.targetID,
                    fromEpoch: 1,
                    toEpoch: 2,
                    mappingPlanRevision: 1,
                    shareGeneration: 0,
                    sourceBinding: binding,
                    manifestHash: prepared.manifestHash,
                    preparedHash,
                    createdAt: Date.now(),
                  })
                  const connected = Runtime.Connected.parse({
                    type: "handshake",
                    protocolVersion: 1,
                    orgID: binding.orgID,
                    deploymentIncarnation: identity.deploymentIncarnation,
                    runtimeID: transfer.targetID,
                    connectionEpoch: 1,
                    signingIdentity: identity,
                    heartbeatMs: 1000,
                    offlineMs: 10000,
                  })
                  await Adoption.run(
                    { permit, signature: await Handoff.signPermit(permit, keys.privateKey) },
                    connected,
                    () =>
                      Epochs.activate(transfer, prepared.manifestHash, () =>
                        Staging.publish({ handoffID: transfer.handoffID, contexts }),
                      ),
                  )
                  const targetIntake = createCommandIntake({
                    identity,
                    runtimeID: transfer.targetID,
                    accountID: "current-controller",
                    connectionEpoch: 1,
                    signal,
                  })
                  await expect(
                    targetIntake.descriptionProof({ subjectID: binding.creatorID, requestID: "original-task" }),
                  ).rejects.toThrow()
                  await continueOwned(transfer.targetID, 2)
                },
              }),
            )
          }
        },
      })
    })
  },
  15000,
)
