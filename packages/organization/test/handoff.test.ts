import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffProtocol as Handoff } from "../../organization-protocol/src/handoff"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationAuthorityHistory } from "../src/authority-history"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { commandFixture } from "./support/commands"
import { connection, keys } from "./support/runtime"

async function fixture() {
  const f = await commandFixture()
  await f.connect(1, true, false, false, true)
  const targetKeys = await keys()
  const target = await f.run(async () => {
    const value = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
    const updated = Record.RuntimeRegistration.parse({ ...value, connectionEpoch: 0, publicKey: targetKeys.publicKey })
    await Storage.write(Keys.runtime("runtime-bob"), updated)
    return updated
  })
  const socket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = reject
  })
  const signed = await connection(target, targetKeys.privateKey, 1)
  signed.proof.handshake.capabilities.push("commands", "handoffs")
  signed.proof.handshake.schemas.commands = 1
  signed.proof.handshake.schemas.handoffs = 1
  signed.signature = await Runtime.sign(signed.proof, targetKeys.privateKey)
  const connected = Promise.withResolvers<unknown>()
  socket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
  socket.send(JSON.stringify(signed))
  Runtime.Connected.parse(await connected.promise)
  await f.run(async () => {
    OrganizationAuthorityHistory.register()
    registerHandoffAuthorityHistory()
    await OrganizationAuthorityHistory.initialize({
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
  })
  const handoffs = createHandoffs({ connections: f.connections, signing: f.signing })
  return {
    ...f,
    targetKeys,
    handoffs,
    async [Symbol.asyncDispose]() {
      socket.close()
      await f[Symbol.asyncDispose]()
    },
  }
}

test("handoff reserves a monotonic epoch and requires exact target consent while blocking conflicting commands", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const input = {
      handoffID: "handoff-1",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    }
    await expect(f.handoffs.prepare(f.credentials.bob, f.sessionID, input)).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    const prepared = await f.handoffs.prepare(f.credentials.alice, f.sessionID, input)
    expect(prepared).toMatchObject({
      phase: "preparing",
      sourceRuntimeID: "runtime-alice",
      targetRuntimeID: "runtime-bob",
      fromEpoch: 1,
      toEpoch: 2,
      targetAccepted: false,
    })
    expect(await f.handoffs.prepare(f.credentials.alice, f.sessionID, input)).toEqual(prepared)
    await expect(
      OrganizationSharing.unshare(f.credentials.alice, f.sessionID, { expectedShareGeneration: 1 }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    await expect(f.commands.input(f.credentials.alice, f.request())).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    await expect(f.handoffs.accept(f.credentials.bob, "handoff-1", { mappingPlanRevision: 2 })).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT" },
    })
    expect(await f.handoffs.accept(f.credentials.bob, "handoff-1", { mappingPlanRevision: 1 })).toMatchObject({
      targetAccepted: true,
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.nextBindingEpoch).toBe(3)
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
  })
})

test("signed source and target facts commit once and activation remains a separate paused publication", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const state = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
      handoffID: "handoff-2",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    })
    await f.handoffs.accept(f.credentials.bob, state.handoffID, { mappingPlanRevision: 1 })
    const tuple = {
      schemaVersion: 1 as const,
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID: state.handoffID,
      sessionID: f.sessionID,
      sourceRuntimeID: "runtime-alice",
      targetRuntimeID: "runtime-bob",
      fromEpoch: 1,
      toEpoch: 2,
      mappingPlanRevision: 1,
      shareGeneration: 1,
      manifestHash: "a".repeat(64),
    }
    async function publish(proof: Handoff.Proof, key: CryptoKey) {
      return f.handoffs.proof({ proof, signature: await Handoff.signProof(proof, key) })
    }
    const frozen = Handoff.Proof.parse({
      ...tuple,
      purpose: "source-frozen",
      commandSeq: state.commandSeq,
      receivedSeq: state.commandSeq,
      compatibilityHash: "b".repeat(64),
      closureHash: "c".repeat(64),
      workspaceMoveReceiptHash: null,
      paused: true,
      drained: true,
    })
    await publish(frozen, f.machineKeys.privateKey)
    const prepared = Handoff.Proof.parse({
      ...tuple,
      purpose: "target-prepared",
      compatibilityHash: "b".repeat(64),
      convertedHash: "d".repeat(64),
      closureHash: "c".repeat(64),
      workspaceMoveReceiptHash: null,
      paused: true,
    })
    await publish(prepared, f.targetKeys.privateKey)
    await expect(f.handoffs.commit(f.credentials.alice, state.handoffID)).rejects.toMatchObject({
      data: { code: "HANDOFF_BLOCKED" },
    })
    const surrender = await f.handoffs.permit(f.credentials.alice, state.handoffID, { purpose: "handoff-surrender" })
    const directory = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    expect(surrender.permit.sourceBinding).toEqual({
      schemaVersion: 1,
      orgID: directory.orgID,
      projectID: directory.projectID,
      creatorID: directory.creatorID,
      driverRuntimeID: tuple.sourceRuntimeID,
      bindingEpoch: tuple.fromEpoch,
    })
    expect(await Handoff.verifyPermit(surrender.permit, surrender.signature, f.signing.identity.publicKey)).toBe(true)
    expect(
      await Handoff.verifyPermit(
        { ...surrender.permit, sourceBinding: { ...surrender.permit.sourceBinding!, creatorID: "another-creator" } },
        surrender.signature,
        f.signing.identity.publicKey,
      ),
    ).toBe(false)
    const surrendered = Handoff.Proof.parse({
      ...tuple,
      purpose: "source-surrendered",
      permitID: surrender.permit.permitID,
      preparedHash: await Handoff.proofHash(prepared),
      gatePersisted: true,
    })
    await f.handoffs.cancel(f.credentials.alice, state.handoffID)
    await publish(surrendered, f.machineKeys.privateKey)
    f.connections.revoke("runtime-alice")
    const committed = await f.handoffs.commit(f.credentials.alice, state.handoffID)
    expect(committed.phase).toBe("committed")
    expect(await f.handoffs.commit(f.credentials.alice, state.handoffID)).toEqual(committed)
    const activation = await f.handoffs.permit(f.credentials.bob, state.handoffID, { purpose: "handoff-activation" })
    expect(activation.permit.sourceBinding).toEqual(surrender.permit.sourceBinding)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBe(state.handoffID)
    const activated = Handoff.Proof.parse({
      ...tuple,
      purpose: "target-activated",
      permitID: activation.permit.permitID,
      preparedHash: await Handoff.proofHash(prepared),
      paused: true,
    })
    const completed = await publish(activated, f.targetKeys.privateKey)
    expect(completed).toMatchObject({
      phase: "completed",
      currentDriver: "runtime-bob",
      bindingEpoch: 2,
      canContinue: true,
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBeUndefined()
    expect((await AuthorityJournal.inspect()).covered).toBe(true)
    await expect(
      publish(
        Handoff.Proof.parse({
          ...tuple,
          purpose: "target-never-activate",
          preparedHash: await Handoff.proofHash(prepared),
          tombstonePersisted: true,
        }),
        f.targetKeys.privateKey,
      ),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
  })
})

test("cancellation retains the handoff lock until a source proof and never reuses its reserved epoch", async () => {
  await using f = await fixture()
  await f.run(async () => {
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    const request = {
      handoffID: "cancel-first",
      targetRuntimeID: "runtime-bob",
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    }
    const first = await f.handoffs.prepare(f.credentials.alice, f.sessionID, request)
    await f.handoffs.cancel(f.credentials.alice, first.handoffID)
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))?.handoffID).toBe(first.handoffID)
    const proof = Handoff.Proof.parse({
      schemaVersion: 1,
      purpose: "source-cancelled",
      orgID: "org",
      deploymentIncarnation: "deployment",
      handoffID: first.handoffID,
      sessionID: f.sessionID,
      sourceRuntimeID: first.sourceRuntimeID,
      targetRuntimeID: first.targetRuntimeID,
      fromEpoch: first.fromEpoch,
      toEpoch: first.toEpoch,
      mappingPlanRevision: 1,
      shareGeneration: 1,
      manifestHash: null,
      gateCancelled: true,
      paused: true,
    })
    const signed = { proof, signature: await Handoff.signProof(proof, f.machineKeys.privateKey) }
    await expect(f.handoffs.proof({ ...signed, signature: "0".repeat(128) })).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    expect(await f.handoffs.proof(signed)).toMatchObject({
      phase: "cancelled",
      currentDriver: "runtime-alice",
      bindingEpoch: 1,
    })
    expect(await f.handoffs.proof(signed)).toMatchObject({ phase: "cancelled" })
    const second = await f.handoffs.prepare(f.credentials.alice, f.sessionID, {
      ...request,
      handoffID: "after-cancel",
      expectedControlRevision: 2,
    })
    expect(second.toEpoch).toBe(3)
    await expect(
      f.handoffs.prepare(f.credentials.alice, f.sessionID, {
        ...request,
        handoffID: "concurrent",
        expectedControlRevision: 3,
      }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
  })
})
