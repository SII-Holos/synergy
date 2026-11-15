import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationSyncProtocol as Sync,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationHandoffRecord as HandoffRecord } from "./handoff-record"
import { OrganizationSigningHistory } from "./signing-history"
import { OrganizationSessionResources } from "./session-resources"
import { OrganizationHandoffEnvironments } from "./handoff-environments"
import { fail } from "./error"

export namespace OrganizationHandoffHistory {
  export type Window = { firstSeq: number; bindingEpoch: number; driverRuntimeID: string }
  export type Binding = Pick<Command.Permit, "runtimeID" | "bindingEpoch" | "commandSeq">
  const Index = z.strictObject({ handoffID: Handoff.Binding.shape.handoffID })
  const EpochIndex = Index.extend({ version: z.literal(1) })
  const key = (id: string) => ["organization", "handoffs", id]
  const sessionIndex = (sessionID: string, id: string) => ["organization", "session-handoffs", sessionID, id]
  const epochIndex = (record: HandoffRecord.RawStored) => [
    "organization",
    "session-handoff-epochs",
    record.sessionID,
    String(record.toEpoch).padStart(16, "0"),
  ]
  const targetIndex = (record: HandoffRecord.RawStored) => [
    "organization",
    "handoff-targets",
    record.targetRuntimeID,
    createHash("sha256").update(record.target.publicKey).digest("hex"),
    record.handoffID,
  ]
  function invalid(): never {
    fail("PROTOCOL_MISMATCH", "Historical Handoff lacks its original terminal binding chain")
  }
  function tuple(record: HandoffRecord.RawStored, proof: z.infer<typeof Handoff.Binding>) {
    return HandoffRecord.bindingFields.every((field) => record[field] === proof[field])
  }
  function identity(session: Record.SessionDirectory, record: HandoffRecord.RawStored) {
    if (
      record.orgID !== session.orgID ||
      record.sessionID !== session.sessionID ||
      record.sourceRuntimeID === record.targetRuntimeID ||
      record.fromEpoch >= record.toEpoch ||
      record.fromEpoch > session.bindingEpoch ||
      record.toEpoch >= session.nextBindingEpoch ||
      record.shareGeneration > session.shareGeneration ||
      record.request.handoffID !== record.handoffID ||
      record.request.targetRuntimeID !== record.targetRuntimeID ||
      record.request.expectedBindingEpoch !== record.fromEpoch ||
      record.request.mappingPlanRevision !== record.mappingPlanRevision ||
      record.source.runtimeID !== record.sourceRuntimeID ||
      record.target.runtimeID !== record.targetRuntimeID ||
      record.source.orgID !== session.orgID ||
      record.target.orgID !== session.orgID ||
      record.source.deploymentIncarnation !== record.deploymentIncarnation ||
      record.target.deploymentIncarnation !== record.deploymentIncarnation
    )
      invalid()
    if (
      record.version !== 1 &&
      record.workspaceContract &&
      (record.workspaceContract.orgID !== session.orgID || record.workspaceContract.sessionID !== session.sessionID)
    )
      invalid()
    if ((record.version === 3 || record.version === 4 || record.version === 5) && record.sourceBinding) {
      const original = record.sourceBinding
      if (
        original.orgID !== session.orgID ||
        original.projectID !== session.projectID ||
        original.creatorID !== session.creatorID ||
        original.driverRuntimeID !== record.sourceRuntimeID ||
        original.bindingEpoch !== record.fromEpoch ||
        record.sourceControlRevision !== record.request.expectedControlRevision + 1
      )
        invalid()
    }
  }
  async function fact(
    record: HandoffRecord.RawStored,
    signed: Handoff.SignedProof | undefined,
    purpose: Handoff.Proof["purpose"],
  ) {
    if (!signed) return
    const proof = signed.proof
    if (
      proof.purpose !== purpose ||
      !tuple(record, proof) ||
      proof.manifestHash !== (record.manifestHash ?? null) ||
      !(await Handoff.verifyProof(
        proof,
        signed.signature,
        purpose.startsWith("source-") ? record.source.publicKey : record.target.publicKey,
      ))
    )
      invalid()
  }
  async function permit(
    source: Record.HistoricalReader,
    session: Record.SessionDirectory,
    record: HandoffRecord.RawStored,
    signed: Handoff.SignedPermit | undefined,
    purpose: Handoff.Permit["purpose"],
  ) {
    if (!signed) return
    const proof = signed.permit
    const signing = OrganizationSigningHistory.identity(source, proof)
    if (
      proof.purpose !== purpose ||
      !tuple(record, proof) ||
      proof.manifestHash !== record.manifestHash ||
      !(await Handoff.verifyPermit(proof, signed.signature, signing.publicKey))
    )
      invalid()
    const original = proof.sourceBinding
    if (
      original &&
      (original.orgID !== session.orgID ||
        original.projectID !== session.projectID ||
        original.creatorID !== session.creatorID ||
        original.driverRuntimeID !== record.sourceRuntimeID ||
        original.bindingEpoch !== record.fromEpoch)
    )
      invalid()
  }
  async function preparation(
    source: Record.HistoricalReader,
    session: Record.SessionDirectory,
    record: HandoffRecord.RawStored,
  ) {
    identity(session, record)
    await fact(record, record.frozen, "source-frozen")
    await fact(record, record.prepared, "target-prepared")
    await permit(source, session, record, record.surrenderPermit, "handoff-surrender")
    await permit(source, session, record, record.activationPermit, "handoff-activation")
    const frozen = record.frozen?.proof,
      prepared = record.prepared?.proof
    if (frozen) {
      if (
        frozen.purpose !== "source-frozen" ||
        frozen.commandSeq !== record.commandSeq ||
        frozen.receivedSeq !== record.commandSeq
      )
        invalid()
      const mapping = record.version === 1 ? { kind: "native" as const } : record.request.workspaceMapping
      if (
        mapping.kind === "organization-object"
          ? !frozen.workspaceMoveReceiptHash
          : frozen.workspaceMoveReceiptHash !== null
      )
        invalid()
      if (mapping.kind === "organization-live" || mapping.kind === "organization-native") {
        if (
          record.version === 1 ||
          !record.workspaceSource ||
          frozen.workspaceSourceHash !== HandoffRecord.sourceSnapshotHash(record)
        )
          invalid()
      } else if (mapping.kind === "native-existing") {
        if (!frozen.workspaceSourceHash || !frozen.fileClosureHash) invalid()
      } else if (frozen.workspaceSourceHash != null) invalid()
    }
    if (prepared) {
      if (
        !record.targetAccepted ||
        !frozen ||
        frozen.purpose !== "source-frozen" ||
        prepared.purpose !== "target-prepared" ||
        frozen.compatibilityHash !== prepared.compatibilityHash ||
        frozen.closureHash !== prepared.closureHash ||
        frozen.fileClosureHash !== prepared.fileClosureHash ||
        frozen.workspaceMoveReceiptHash !== prepared.workspaceMoveReceiptHash ||
        (frozen.workspaceSourceHash ?? null) !== (prepared.workspaceSourceHash ?? null)
      )
        invalid()
      const preparedHash = await Handoff.proofHash(prepared)
      if (
        (record.surrenderPermit && record.surrenderPermit.permit.preparedHash !== preparedHash) ||
        (record.activationPermit && record.activationPermit.permit.preparedHash !== preparedHash)
      )
        invalid()
    } else if (record.surrenderPermit || record.activationPermit) invalid()
    const mapping = "environmentMapping" in record.request && record.request.environmentMapping
    if (mapping) {
      const expected = await Handoff.environmentMappingHash(mapping)
      if (
        (frozen && (frozen.purpose !== "source-frozen" || frozen.environmentMappingHash !== expected)) ||
        (prepared && (prepared.purpose !== "target-prepared" || prepared.environmentMappingHash !== expected))
      )
        invalid()
    }
    if (record.version === 5 && frozen) {
      const checkpoint = frozen.purpose === "source-frozen" && frozen.syncCheckpoint
      if (
        !checkpoint ||
        (prepared &&
          (prepared.purpose !== "target-prepared" ||
            prepared.syncCheckpointHash !== (await Handoff.syncCheckpointHash(checkpoint))))
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
    if ("difference" in record) {
      if (
        (record.difference || record.previewReleased) &&
        (!("workspaceMapping" in record.request) ||
          !Handoff.isNativeTargetMapping(record.request.workspaceMapping) ||
          !record.frozen)
      )
        invalid()
      await fact(record, record.difference, "target-difference")
      await fact(record, record.previewReleased, "target-preview-released")
    }
  }
  async function transition(
    source: Record.HistoricalReader,
    session: Record.SessionDirectory,
    record: HandoffRecord.RawStored,
  ) {
    await preparation(source, session, record)
    const frozen = record.frozen,
      prepared = record.prepared,
      surrendered = record.surrendered
    const surrender = record.surrenderPermit
    if (
      !["committed", "completed"].includes(record.phase) ||
      !record.targetAccepted ||
      !frozen ||
      !prepared ||
      !surrendered ||
      !surrender ||
      record.cancelRequested ||
      record.cancelled ||
      record.retired ||
      surrendered.proof.purpose !== "source-surrendered" ||
      surrendered.proof.permitID !== surrender.permit.permitID ||
      surrendered.proof.preparedHash !== (await Handoff.proofHash(prepared.proof))
    )
      invalid()
    await fact(record, surrendered, "source-surrendered")
    if (record.version === 5 && !surrender.permit.sourceBinding) invalid()
    if (record.phase === "completed") {
      const activated = record.activated,
        activation = record.activationPermit
      if (
        !activated ||
        !activation ||
        activated.proof.purpose !== "target-activated" ||
        activated.proof.permitID !== activation.permit.permitID ||
        activated.proof.preparedHash !== (await Handoff.proofHash(prepared.proof))
      )
        invalid()
      await fact(record, activated, "target-activated")
    } else if (record.activated || record.activationPermit) invalid()
  }
  export async function terminal(
    source: Record.HistoricalReader,
    session: Record.SessionDirectory,
    handoffID: string,
  ): Promise<HandoffRecord.RawStored> {
    const record = source.read(HandoffRecord.RawStored, key(handoffID))
    if (
      record.handoffID !== handoffID ||
      session.handoffID ||
      source.read(Index, sessionIndex(session.sessionID, handoffID)).handoffID !== handoffID ||
      source.read(EpochIndex, epochIndex(record)).handoffID !== handoffID ||
      (record.target.runtimeKind === "member" && source.read(EpochIndex, targetIndex(record)).handoffID !== handoffID)
    )
      invalid()
    if (record.phase === "completed") {
      if (record.toEpoch > session.bindingEpoch) invalid()
      await transition(source, session, record)
      return record
    }
    if (
      record.phase !== "cancelled" ||
      !record.cancelRequested ||
      !record.cancelled ||
      record.surrendered ||
      record.activated ||
      record.activationPermit
    )
      invalid()
    await preparation(source, session, record)
    await fact(record, record.cancelled, "source-cancelled")
    if (record.retired) {
      const retired = record.retired.proof
      if (
        !("workspaceMapping" in record.request) ||
        !Handoff.isNativeTargetMapping(record.request.workspaceMapping) ||
        !record.prepared ||
        retired.purpose !== "target-never-activate" ||
        retired.preparedHash !== (await Handoff.proofHash(record.prepared.proof))
      )
        invalid()
      await fact(record, record.retired, "target-never-activate")
    }
    return record
  }
  export function continuationSelection(record: HandoffRecord.RawStored) {
    if (record.phase !== "completed" || record.version === 1 || !record.workspaceContract) return
    const mapping = record.request.workspaceMapping
    if (
      mapping.kind !== "organization-object" &&
      !Handoff.isNativeTargetMapping(mapping) &&
      !record.request.environmentMapping
    )
      return
    const contract = record.workspaceContract
    const workspace =
      mapping.kind === "organization-object"
        ? mapping.target
        : Handoff.isNativeTargetMapping(mapping)
          ? null
          : (contract.selection?.infrastructure.workspace ?? null)
    return {
      before: contract,
      after: OrganizationSessionResources.mappedWorkspace(
        contract,
        workspace,
        record.request.environmentMapping
          ? OrganizationHandoffEnvironments.selected(record.request.environmentMapping)
          : undefined,
      ),
    }
  }
  export async function binding(source: Record.HistoricalReader, session: Record.SessionDirectory, input: Binding) {
    let incoming: HandoffRecord.RawStored | undefined
    for (const row of source.entries(["organization", "session-handoffs", session.sessionID])) {
      const index = Index.parse(row.value)
      if (!HandoffRecord.same(row.key, sessionIndex(session.sessionID, index.handoffID))) invalid()
      const record = source.read(HandoffRecord.RawStored, key(index.handoffID))
      if (record.handoffID !== index.handoffID || record.sessionID !== session.sessionID) invalid()
      if (record.phase !== "completed" || record.toEpoch !== input.bindingEpoch) continue
      if (incoming || record.targetRuntimeID !== input.runtimeID || input.commandSeq <= record.commandSeq) invalid()
      incoming = record
    }
    if (incoming) await terminal(source, session, incoming.handoffID)
    else if (input.bindingEpoch !== 1) invalid()
    return chain(source, session, input)
  }
  async function chain(source: Record.HistoricalReader, session: Record.SessionDirectory, input: Binding) {
    let runtimeID = input.runtimeID,
      bindingEpoch = input.bindingEpoch
    let watermark = input.commandSeq
    if (session.handoffID || bindingEpoch > session.bindingEpoch) invalid()
    while (runtimeID !== session.driverRuntimeID || bindingEpoch !== session.bindingEpoch) {
      let selected: HandoffRecord.RawStored | undefined
      for (const row of source.entries(["organization", "session-handoffs", session.sessionID])) {
        const index = Index.parse(row.value)
        if (!HandoffRecord.same(row.key, sessionIndex(session.sessionID, index.handoffID))) invalid()
        const record = source.read(HandoffRecord.RawStored, key(index.handoffID))
        if (record.handoffID !== index.handoffID || record.sessionID !== session.sessionID) invalid()
        if (record.phase !== "completed" || record.fromEpoch !== bindingEpoch || record.sourceRuntimeID !== runtimeID)
          continue
        if (
          selected ||
          record.toEpoch <= bindingEpoch ||
          record.toEpoch > session.bindingEpoch ||
          record.commandSeq < watermark
        )
          invalid()
        selected = record
      }
      if (!selected) invalid()
      await terminal(source, session, selected.handoffID)
      runtimeID = selected.targetRuntimeID
      bindingEpoch = selected.toEpoch
      watermark = selected.commandSeq
    }
  }
  export async function validate(source: Record.HistoricalReader, address: string[], value: unknown) {
    if (
      address[0] !== "organization" ||
      !["handoffs", "session-handoffs", "session-handoff-epochs", "handoff-targets"].includes(address[1] ?? "")
    )
      return false
    const handoffID =
      address[1] === "handoffs"
        ? HandoffRecord.RawStored.parse(value).handoffID
        : (address[1] === "session-handoffs" ? Index : EpochIndex).parse(value).handoffID
    const record = source.read(HandoffRecord.RawStored, key(handoffID))
    const session = source.read(Record.SessionDirectory, Keys.session(record.sessionID))
    const expected =
      address[1] === "handoffs"
        ? key(handoffID)
        : address[1] === "session-handoffs"
          ? sessionIndex(session.sessionID, handoffID)
          : address[1] === "session-handoff-epochs"
            ? epochIndex(record)
            : targetIndex(record)
    if (
      !HandoffRecord.same(address, expected) ||
      (address[1] === "handoffs" && !HandoffRecord.same(record, HandoffRecord.RawStored.parse(value))) ||
      ((address[1] === "session-handoff-epochs" || address[1] === "handoff-targets") &&
        EpochIndex.parse(value).handoffID !== handoffID) ||
      (address[1] === "handoff-targets" && record.target.runtimeKind !== "member")
    )
      invalid()
    await terminal(source, session, handoffID)
    await chain(source, session, {
      runtimeID: record.phase === "completed" ? record.targetRuntimeID : record.sourceRuntimeID,
      bindingEpoch: record.phase === "completed" ? record.toEpoch : record.fromEpoch,
      commandSeq: record.commandSeq,
    })
    return true
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
