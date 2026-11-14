import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationHandoffRecord as HandoffRecord } from "./handoff-record"
import { fail } from "./error"

export namespace OrganizationHandoffHistory {
  export type Window = { firstSeq: number; bindingEpoch: number; driverRuntimeID: string }
  function invalid(): never {
    fail("PROTOCOL_MISMATCH", "Historical shared transcript lacks its original committed Handoff binding chain")
  }
  function tuple(record: HandoffRecord.RawStored, proof: z.infer<typeof Handoff.Binding>) {
    return HandoffRecord.bindingFields.every((field) => record[field] === proof[field])
  }
  async function transition(
    source: Record.HistoricalReader,
    session: Record.SessionDirectory,
    record: HandoffRecord.RawStored,
  ) {
    const frozen = record.frozen,
      prepared = record.prepared,
      surrendered = record.surrendered
    const permit = record.surrenderPermit
    const signing = source.read(Record.SigningIdentity, Keys.signingIdentity())
    if (
      signing.orgID !== record.orgID ||
      signing.deploymentIncarnation !== record.deploymentIncarnation ||
      !["committed", "completed"].includes(record.phase) ||
      !record.targetAccepted ||
      record.orgID !== session.orgID ||
      record.sessionID !== session.sessionID ||
      record.source.runtimeID !== record.sourceRuntimeID ||
      record.target.runtimeID !== record.targetRuntimeID ||
      record.source.orgID !== session.orgID ||
      record.target.orgID !== session.orgID ||
      record.source.deploymentIncarnation !== record.deploymentIncarnation ||
      record.target.deploymentIncarnation !== record.deploymentIncarnation ||
      !frozen ||
      frozen.proof.purpose !== "source-frozen" ||
      !tuple(record, frozen.proof) ||
      !prepared ||
      prepared.proof.purpose !== "target-prepared" ||
      !tuple(record, prepared.proof) ||
      !surrendered ||
      surrendered.proof.purpose !== "source-surrendered" ||
      !tuple(record, surrendered.proof) ||
      !permit ||
      permit.permit.purpose !== "handoff-surrender" ||
      !tuple(record, permit.permit) ||
      permit.permit.keyID !== signing.keyID ||
      !(await Handoff.verifyPermit(permit.permit, permit.signature, signing.publicKey)) ||
      !record.manifestHash ||
      frozen.proof.manifestHash !== record.manifestHash ||
      prepared.proof.manifestHash !== record.manifestHash ||
      surrendered.proof.manifestHash !== record.manifestHash ||
      permit.permit.manifestHash !== record.manifestHash ||
      frozen.proof.compatibilityHash !== prepared.proof.compatibilityHash ||
      frozen.proof.closureHash !== prepared.proof.closureHash ||
      frozen.proof.fileClosureHash !== prepared.proof.fileClosureHash ||
      surrendered.proof.permitID !== permit.permit.permitID ||
      !(await Handoff.verifyProof(frozen.proof, frozen.signature, record.source.publicKey)) ||
      !(await Handoff.verifyProof(prepared.proof, prepared.signature, record.target.publicKey)) ||
      !(await Handoff.verifyProof(surrendered.proof, surrendered.signature, record.source.publicKey))
    )
      invalid()
    const preparedHash = await Handoff.proofHash(prepared.proof)
    if (surrendered.proof.preparedHash !== preparedHash || permit.permit.preparedHash !== preparedHash) invalid()
    const original = permit.permit.sourceBinding
    if (
      original &&
      (original.orgID !== session.orgID ||
        original.projectID !== session.projectID ||
        original.creatorID !== session.creatorID ||
        original.driverRuntimeID !== record.sourceRuntimeID ||
        original.bindingEpoch !== record.fromEpoch)
    )
      invalid()
    if (record.phase === "completed") {
      const activated = record.activated,
        activation = record.activationPermit
      if (
        !activated ||
        activated.proof.purpose !== "target-activated" ||
        !tuple(record, activated.proof) ||
        activated.proof.manifestHash !== record.manifestHash ||
        activated.proof.preparedHash !== preparedHash ||
        !activation ||
        activation.permit.purpose !== "handoff-activation" ||
        !tuple(record, activation.permit) ||
        activation.permit.keyID !== signing.keyID ||
        activation.permit.manifestHash !== record.manifestHash ||
        !(await Handoff.verifyPermit(activation.permit, activation.signature, signing.publicKey)) ||
        activated.proof.permitID !== activation.permit.permitID ||
        activation.permit.preparedHash !== preparedHash ||
        !(await Handoff.verifyProof(activated.proof, activated.signature, record.target.publicKey))
      )
        invalid()
    }
    if (record.version === 5) {
      const checkpoint = frozen.proof.syncCheckpoint
      if (
        !original ||
        !checkpoint ||
        prepared.proof.syncCheckpointHash !== (await Handoff.syncCheckpointHash(checkpoint))
      )
        invalid()
      const batch = checkpoint.pendingBatch
      if (batch) {
        if (
          batch.sessionID !== session.sessionID ||
          batch.projectID !== session.projectID ||
          batch.bindingEpoch !== record.fromEpoch ||
          batch.shareGeneration !== record.shareGeneration
        )
          invalid()
        const marker = source.read(
          Record.SharedBatch,
          Keys.sharedBatch(batch.sessionID, batch.shareGeneration, batch.firstSeq),
        )
        const actual = Sync.BatchIdentity.parse({
          sessionID: marker.sessionID,
          projectID: marker.projectID,
          bindingEpoch: marker.bindingEpoch,
          shareGeneration: marker.shareGeneration,
          firstSeq: marker.firstSeq,
          lastSeq: marker.lastSeq,
          payloadHash: marker.payloadHash,
        })
        if (!HandoffRecord.same(actual, batch)) invalid()
      }
    }
  }
  export async function windows(source: Record.HistoricalReader, session: Record.SessionDirectory, generation: number) {
    const first = source.read(Record.SharedEvent, Keys.sharedEvent(session.sessionID, generation, 1)).event
    if (
      first.type !== "session" ||
      first.session.sessionID !== session.sessionID ||
      first.session.projectID !== session.projectID ||
      first.session.creatorID !== session.creatorID ||
      first.session.shareGeneration !== generation
    )
      invalid()
    const result: Window[] = [
      { firstSeq: 1, bindingEpoch: first.session.bindingEpoch, driverRuntimeID: first.session.driverRuntimeID },
    ]
    let current = result[0]!
    while (current.bindingEpoch !== session.bindingEpoch || current.driverRuntimeID !== session.driverRuntimeID) {
      let selected: HandoffRecord.RawStored | undefined
      for (const row of source.entries(["organization", "session-handoffs", session.sessionID])) {
        if (row.key.length !== 4) invalid()
        const index = Handoff.Binding.pick({ handoffID: true }).parse(row.value)
        if (row.key[3] !== index.handoffID) invalid()
        const record = source.read(HandoffRecord.RawStored, ["organization", "handoffs", index.handoffID])
        if (record.handoffID !== index.handoffID || record.sessionID !== session.sessionID) invalid()
        if (
          record.shareGeneration !== generation ||
          !["committed", "completed"].includes(record.phase) ||
          record.fromEpoch !== current.bindingEpoch ||
          record.sourceRuntimeID !== current.driverRuntimeID
        )
          continue
        if (selected || record.toEpoch <= current.bindingEpoch || record.toEpoch > session.bindingEpoch) invalid()
        selected = record
      }
      if (!selected) invalid()
      await transition(source, session, selected)
      let boundary: Record.SharedBatch | undefined
      for (const row of source.entries(["organization", "shared-batches", session.sessionID, String(generation)])) {
        const batch = Record.SharedBatch.parse(row.value)
        if (batch.bindingEpoch !== selected.toEpoch) continue
        if (!boundary || batch.firstSeq < boundary.firstSeq) boundary = batch
      }
      if (
        !boundary ||
        boundary.sessionID !== session.sessionID ||
        boundary.projectID !== session.projectID ||
        boundary.shareGeneration !== generation ||
        boundary.firstSeq <= current.firstSeq ||
        boundary.firstSeq !== boundary.lastSeq
      )
        invalid()
      const event = source.read(
        Record.SharedEvent,
        Keys.sharedEvent(session.sessionID, generation, boundary.firstSeq),
      ).event
      if (
        event.type !== "session" ||
        event.session.sessionID !== session.sessionID ||
        event.session.projectID !== session.projectID ||
        event.session.creatorID !== session.creatorID ||
        event.session.bindingEpoch !== selected.toEpoch ||
        event.session.driverRuntimeID !== selected.targetRuntimeID ||
        event.session.shareGeneration !== generation ||
        createHash("sha256")
          .update(JSON.stringify({ firstSeq: boundary.firstSeq, lastSeq: boundary.lastSeq, events: [event] }))
          .digest("hex") !== boundary.payloadHash
      )
        invalid()
      current = {
        firstSeq: boundary.firstSeq,
        bindingEpoch: selected.toEpoch,
        driverRuntimeID: selected.targetRuntimeID,
      }
      result.push(current)
    }
    return result
  }
  export function at(windows: readonly Window[], sequence: number) {
    let selected: Window | undefined
    for (const value of windows) {
      if (value.firstSeq > sequence) break
      selected = value
    }
    if (!selected) invalid()
    return selected
  }
}
