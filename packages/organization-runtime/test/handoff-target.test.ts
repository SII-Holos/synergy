import { expect, spyOn, test } from "bun:test"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferEpochs as Epochs,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { registerSessionSchema } from "../src/session-schema"
import { registerOrganizationTransferOwner } from "../src/session-transfer"
import { OrganizationHandoffObjects as Objects } from "../src/handoff-objects"
import { OrganizationHandoffTarget as Target } from "../src/handoff-target"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import path from "node:path"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { fixture } from "./support/organization"
import { prepareHostedHome, NativeHomeReaderContract, runtimeIdentityDigest } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"

test("the destination controller prepares actual private owner partitions and requires the separate permit for atomic paused adoption", async () => {
  await using f = await fixture()
  const hosted = await prepareHostedHome({
    baseDirectory: path.join(f.root, "targets"),
    identity: { orgID: f.identity.orgID, hostID: "target-controller" },
    origin: f.origin,
  })
  const registration = await enrollHostedRuntime({
    home: hosted.home,
    identity: hosted.identity,
    ca: f.ca,
    ticket: (
      await f.client.orgRuntime.registerHosted(
        {
          orgHostedRuntimeRegistration: { name: "Destination owner", publicKey: hosted.publicKey },
        },
        { headers: f.headers, throwOnError: true },
      )
    ).data,
  })
  const sourceBinding = {
    schemaVersion: 1 as const,
    orgID: f.identity.orgID,
    projectID: "target-project",
    creatorID: f.identity.accountID,
    driverRuntimeID: "runtime-a",
    bindingEpoch: 1,
  }
  let rejectActivation = true
  const activationFailure = new Error("The target activation receipt failed")
  const register = () => {
    Core.register()
    registerSessionSchema(sourceBinding)
    registerOrganizationTransferOwner()
    StorageMutationGuard.register("target-publication-fault", async (_tx, keys) => {
      if (
        rejectActivation &&
        keys.some((key) => key[0] === "organization_handoff_target" && key.at(-1) === "activated")
      )
        throw activationFailure
    })
  }
  await using source = await testRuntime({ register })
  const targetRegister = () => {
    HomeOwnership.select({
      owner: "organization-runtime",
      identity: runtimeIdentityDigest(hosted.identity),
      readerContract: NativeHomeReaderContract,
    })
    register()
  }
  let target = await testRuntime({ register: targetRegister, home: hosted.home })
  try {
    const signal = new AbortController().signal
    const captured = await source.run(async () => {
      const scope = await Scope.registerProject({
        type: "project",
        id: sourceBinding.projectID,
        local: null,
        time: { created: 1, updated: 1 },
      })
      return ScopeContext.provide({
        scope,
        workspace: null,
        fn: async () => {
          const root = await Session.create({ organization: sourceBinding, workspaceID: null, environmentID: null })
          const child = await Session.create({ parentID: root.id, workspaceID: null, environmentID: null })
          const actor = {
            kind: "account" as const,
            orgID: sourceBinding.orgID,
            subjectID: sourceBinding.creatorID,
            displayName: "Original creator",
            clientKind: "web" as const,
            requestID: "original-task",
          }
          const queued = await SessionInbox.enqueueUser(
            {
              sessionID: root.id,
              model: { providerID: "test", modelID: "test" },
              parts: [{ type: "text", text: "Keep this original input without another admission" }],
            },
            { actor },
          )
          const binding = {
            sessionID: root.id,
            scopeID: scope.id,
            handoffID: "destination-controller",
            sourceID: "runtime-a",
            targetID: registration.runtimeID,
            fromEpoch: 1,
            toEpoch: 2,
          }
          const objects = await Objects.open(
            {
              orgID: sourceBinding.orgID,
              deploymentIncarnation: registration.deploymentIncarnation,
              role: "source",
              binding,
            },
            signal,
          )
          const prepared = await Source.prepare({ binding, store: objects.store, signal, async verify() {} })
          await objects.sealSource()
          return { root, child, binding, objects, prepared, queued, actor }
        },
      })
    })
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const publicKey = await Runtime.publicKey(keys.publicKey)
    const connection = Runtime.Connected.parse({
      type: "handshake",
      protocolVersion: 1,
      orgID: sourceBinding.orgID,
      deploymentIncarnation: registration.deploymentIncarnation,
      runtimeID: registration.runtimeID,
      connectionEpoch: 1,
      signingIdentity: {
        schemaVersion: 1,
        orgID: sourceBinding.orgID,
        deploymentIncarnation: registration.deploymentIncarnation,
        keyID: "service-key",
        publicKey,
      },
      heartbeatMs: 1000,
      offlineMs: 10000,
    })
    const tuple = {
      schemaVersion: 1 as const,
      orgID: sourceBinding.orgID,
      deploymentIncarnation: registration.deploymentIncarnation,
      handoffID: captured.binding.handoffID,
      sessionID: captured.root.id,
      sourceRuntimeID: "runtime-a",
      targetRuntimeID: registration.runtimeID,
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 0,
    }
    const frozen = Handoff.Proof.parse({
      ...tuple,
      purpose: "source-frozen",
      manifestHash: captured.prepared.manifestHash,
      commandSeq: 0,
      receivedSeq: 0,
      compatibilityHash: Target.compatibilityHash(captured.prepared.root.owners),
      closureHash: captured.prepared.closureHash,
      fileClosureHash: null,
      workspaceMoveReceiptHash: null,
      paused: true,
      drained: true,
    })
    const plan = Handoff.MachinePlan.parse({
      ...tuple,
      purpose: "handoff-machine",
      operation: "prepare-target",
      sourceBinding,
      requestID: "target-prepare",
      keyID: "service-key",
      runtimeID: registration.runtimeID,
      connectionEpoch: 1,
      commandSeq: 0,
      controlRevision: 0,
      authRevision: 1,
      actor: {
        kind: "account",
        orgID: sourceBinding.orgID,
        subjectID: f.identity.accountID,
        displayName: "Creator",
        clientKind: "web",
        requestID: "target-prepare",
      },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 15000,
      manifestHash: captured.prepared.manifestHash,
      frozen: { proof: frozen, signature: await Handoff.signProof(frozen, keys.privateKey) },
    })
    const authorization = { plan, signature: await Handoff.signMachinePlan(plan, keys.privateKey) }
    const mapping = async () => ({ workspaceIDs: {}, environmentID: null })
    let rangeReads = 0
    const resources = {
      async handoffObject(
        reference: { manifestHash: string },
        range: { hash: string; offset: number; length: number },
      ) {
        rangeReads++
        return source.run(() =>
          captured.objects.range({
            manifestHash: reference.manifestHash,
            hash: range.hash,
            offset: range.offset,
            limit: range.length,
          }),
        )
      },
    }
    await using foreign = await testRuntime({ register })
    await foreign.run(async () => {
      const before = rangeReads
      const wrong = Target.create({ identity: hosted.identity, runtimeID: registration.runtimeID })
      await expect(wrong.prepare({ authorization, connection, resources, mapping, signal })).rejects.toThrow(
        "enrolled Runtime Home",
      )
      expect(rangeReads).toBe(before)
      expect(
        await Storage.readMany([
          ["organization_handoff_target", plan.orgID, plan.deploymentIncarnation, plan.handoffID, "prepared"],
        ]),
      ).toEqual([undefined])
      await expect(Epochs.inspect(captured.binding)).rejects.toThrow()
      await expect(Session.get(captured.root.id)).rejects.toThrow()
    })
    let controller = await target.run(() =>
      Target.create({ identity: hosted.identity, runtimeID: registration.runtimeID }),
    )
    const fact = await target.run(async () => {
      const verifying = Promise.withResolvers<void>()
      const verified = Promise.withResolvers<void>()
      const firstSignal = new AbortController()
      const firstReason = new Error("The destination closed while its authority was verified")
      const verify = Handoff.verifyMachinePlan
      const delayed = spyOn(Handoff, "verifyMachinePlan").mockImplementationOnce(async (...args) => {
        verifying.resolve()
        await verified.promise
        return verify(...args)
      })
      try {
        const mutable = { authorization, connection, resources, mapping, signal: firstSignal.signal }
        const interrupted = controller.prepare(mutable)
        void interrupted.catch(() => {})
        await verifying.promise
        mutable.signal = new AbortController().signal
        firstSignal.abort(firstReason)
        verified.resolve()
        await expect(interrupted).rejects.toBe(firstReason)
      } finally {
        delayed.mockRestore()
      }
      const original = new AbortController()
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const reason = new Error("The original destination request ended")
      const mutable = {
        authorization,
        connection,
        resources,
        signal: original.signal,
        async mapping() {
          entered.resolve()
          await resume.promise
          return mapping()
        },
      }
      const interrupted = controller.prepare(mutable)
      void interrupted.catch(() => {})
      await entered.promise
      mutable.signal = new AbortController().signal
      original.abort(reason)
      resume.resolve()
      await expect(interrupted).rejects.toBe(reason)
      const preparing = Promise.withResolvers<void>()
      const finishPreparation = Promise.withResolvers<void>()
      let mappings = 0
      const concurrent = {
        authorization,
        connection,
        resources,
        signal,
        async mapping() {
          mappings++
          preparing.resolve()
          await finishPreparation.promise
          return mapping()
        },
      }
      const first = controller.prepare(concurrent)
      void first.catch(() => {})
      await preparing.promise
      const inspection = Handoff.MachinePlan.parse({
        ...plan,
        operation: "inspect-target",
        requestID: "inspect-working-target",
        actor: { ...plan.actor, requestID: "inspect-working-target" },
      })
      let working: Handoff.MachineExecution | undefined
      let joined: Promise<Handoff.Proof> | undefined
      try {
        working = await controller.inspect({
          authorization: { plan: inspection, signature: await Handoff.signMachinePlan(inspection, keys.privateKey) },
          connection,
          mapping,
          signal,
        })
        joined = controller.prepare(concurrent)
        void joined.catch(() => {})
      } finally {
        finishPreparation.resolve()
      }
      const fact = await first
      const joinedFact = await joined
      expect(working).toMatchObject({ state: "working", stage: "preparing", facts: [] })
      expect(joinedFact).toEqual(fact)
      expect(mappings).toBe(2)
      expect(fact).toMatchObject({
        ...tuple,
        purpose: "target-prepared",
        manifestHash: captured.prepared.manifestHash,
        paused: true,
      })
      await expect(Session.get(captured.root.id)).rejects.toThrow()
      await expect(Session.get(captured.child.id)).rejects.toThrow()
      expect(await controller.prepare({ authorization, connection, resources, mapping, signal })).toEqual(fact)
      await expect(
        controller.prepare({
          authorization,
          connection,
          resources,
          mapping: async () => ({ workspaceIDs: { unused: "another-workspace" }, environmentID: null }),
          signal,
        }),
      ).rejects.toThrow()
      return fact
    })
    await target.close()
    target = await testRuntime({ register: targetRegister, home: hosted.home })
    controller = await target.run(() => Target.create({ identity: hosted.identity, runtimeID: registration.runtimeID }))
    await target.run(async () => {
      await expect(Session.get(captured.root.id)).rejects.toThrow()
      const preparedHash = await Handoff.proofHash(fact)
      await source.run(() =>
        Source.surrender({
          binding: captured.binding,
          manifestHash: captured.prepared.manifestHash,
          preparedHash,
          signal,
          async verify() {},
        }),
      )
      const permit = Handoff.Permit.parse({
        ...tuple,
        purpose: "handoff-activation",
        keyID: "service-key",
        permitID: "separate-activation",
        sourceBinding,
        manifestHash: captured.prepared.manifestHash,
        preparedHash,
        createdAt: Date.now(),
      })
      const signed = { permit, signature: await Handoff.signPermit(permit, keys.privateKey) }
      const activation = Handoff.MachinePlan.parse({
        ...plan,
        operation: "activate-target",
        requestID: "target-activate",
        actor: { ...plan.actor, requestID: "target-activate" },
        authorization: signed,
      })
      const invalid = { ...activation, authorization: { ...signed, signature: "0".repeat(128) } }
      await expect(
        controller.activate({
          authorization: { plan: invalid, signature: await Handoff.signMachinePlan(invalid, keys.privateKey) },
          connection,
          mapping,
          signal,
        }),
      ).rejects.toThrow()
      await expect(Session.get(captured.root.id)).rejects.toThrow()
      const activate = async () =>
        controller.activate({
          authorization: { plan: activation, signature: await Handoff.signMachinePlan(activation, keys.privateKey) },
          connection,
          mapping,
          signal,
        })
      await expect(activate()).rejects.toBe(activationFailure)
      await expect(Session.get(captured.root.id)).rejects.toThrow()
      await expect(Session.get(captured.child.id)).rejects.toThrow()
      expect((await Epochs.inspect(captured.binding)).phase).toBe("prepared")
      rejectActivation = false
      const activated = await controller.activate({
        authorization: { plan: activation, signature: await Handoff.signMachinePlan(activation, keys.privateKey) },
        connection,
        mapping,
        signal,
      })
      expect(activated).toMatchObject({
        ...tuple,
        purpose: "target-activated",
        permitID: permit.permitID,
        preparedHash,
        paused: true,
      })
      for (const id of [captured.root.id, captured.child.id]) {
        expect(await Session.get(id)).toMatchObject({
          id,
          paused: expect.anything(),
          organization: { ...sourceBinding, driverRuntimeID: registration.runtimeID, bindingEpoch: 2 },
        })
        expect(
          (
            await Epochs.inspect({
              ...captured.binding,
              sessionID: id,
              ...(id === captured.root.id ? {} : { rootSessionID: captured.root.id }),
            })
          ).phase,
        ).toBe("activated")
      }
      const queue = await SessionInbox.list(captured.root.id)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({
        id: captured.queued.id,
        messageID: captured.queued.messageID,
        message: { actor: captured.actor },
      })
      expect(
        await controller.activate({
          authorization: { plan: activation, signature: await Handoff.signMachinePlan(activation, keys.privateKey) },
          connection,
          mapping,
          signal,
        }),
      ).toEqual(activated)
    })
  } finally {
    await target.close()
  }
}, 15000)
