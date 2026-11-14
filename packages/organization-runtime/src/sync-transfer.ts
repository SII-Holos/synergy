import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferSource as Source,
  SessionTransferStaging as Staging,
  SessionTransferOwners as Owners,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { binding as nativeBinding, State, Draft, originalBatch, ProjectionRecord } from "./sync-outbox"
import { AttachmentRecord, BlobRecord } from "./sync-projection"
import { drainMemberSync, settleMemberSync, inspectMemberSyncBatch } from "./sync-exporter"

export namespace OrganizationSyncTransfer {
  export const id = "organization-sync"
  const version = 1
  const Count = z.number().int().nonnegative().safe()
  const Header = z.strictObject({
    version: z.literal(version),
    binding: Epochs.Binding,
    rootSessionID: z.string().min(1),
    sessionID: z.string().min(1),
    sourceBinding: Protocol.SessionBinding,
    records: Count,
    pendingBatch: Sync.BatchIdentity.nullable(),
  })
  type Header = z.infer<typeof Header>
  export interface Reader {
    record(input: { manifestHash: string; ownerID: string; key: readonly string[] }): Promise<unknown>
  }
  const headerKey = (handoffID: string, sessionID: string) => [id, handoffID, sessionID, "header"]
  const same = isDeepStrictEqual
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const json = (value: unknown) =>
    (async function* () {
      yield new TextEncoder().encode(JSON.stringify(value))
    })()
  const prefix = (header: Header) => ["organization-sync", header.sourceBinding.orgID, "sessions", header.sessionID]
  const root = (header: Header) => header.sessionID === header.rootSessionID
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  function batch(value: unknown, header: Header) {
    const parsed = originalBatch(value, header.sourceBinding.projectID)
    if (
      !root(header) ||
      parsed.stored.sessionID !== header.sessionID ||
      parsed.stored.bindingEpoch !== header.sourceBinding.bindingEpoch
    )
      fail("Portable sync batch changed its original native root binding")
    return parsed
  }
  function classify(row: Owners.StagedRecord, header: Header) {
    const orgID = header.sourceBinding.orgID
    if (same(row.key, Keys.registeredRoot(orgID, header.sessionID))) {
      if (!root(header) || z.strictObject({ sessionID: z.string() }).parse(row.value).sessionID !== header.sessionID)
        fail("Portable sync root index has another canonical Session")
      return { kind: "root" as const }
    }
    const owned = prefix(header)
    if (!owned.every((part, index) => row.key[index] === part)) fail("Portable sync contains another owner's key")
    const tail = row.key.slice(owned.length)
    if (tail.length === 1 && tail[0] === "state") {
      const value = State.parse(row.value)
      if (!root(header) || value.orgID !== orgID || value.sessionID !== header.sessionID)
        fail("Portable sync state has another original root")
      return { kind: "state" as const, value }
    }
    if (tail.length === 2 && tail[0] === "drafts") {
      const value = Draft.parse(row.value)
      if (
        !root(header) ||
        value.sessionID !== header.sessionID ||
        value.draftID !== tail[1] ||
        value.bytes !== Buffer.byteLength(JSON.stringify(value.event))
      )
        fail("Portable draft identity changed")
      return { kind: "draft" as const, value }
    }
    if (tail.length === 2 && tail[0] === "draft-order") {
      const value = z.strictObject({ draftID: z.string().min(1) }).parse(row.value)
      const sequence = Number(tail[1])
      if (
        !root(header) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        String(sequence).padStart(16, "0") !== tail[1]
      )
        fail("Portable draft order is outside its original local sequence")
      return { kind: "order" as const, value, sequence }
    }
    if (tail.length === 2 && tail[0] === "projections") {
      const value = ProjectionRecord.parse(row.value)
      if (!root(header) || value.draftID !== tail[1]) fail("Portable projection has another original draft")
      return { kind: "projection" as const, value }
    }
    if (tail.length === 1 && tail[0] === "batch") {
      const value = batch(row.value, header)
      if (!same(value.identity, header.pendingBatch)) fail("Portable batch differs from its captured header")
      return { kind: "batch" as const, ...value }
    }
    if ((tail.length === 2 || tail.length === 5) && tail[0] === "attachments") {
      const value = AttachmentRecord.parse(row.value)
      if (
        value.sessionID !== header.sessionID ||
        value.scopeID !== header.binding.scopeID ||
        value.attachmentID !== tail[1]
      )
        fail("Portable attachment has another native owner")
      if (
        tail.length === 5 &&
        (tail[2] !== "content" ||
          value.artifact.status !== "complete" ||
          value.artifact.sha256 !== tail[3] ||
          String(value.artifact.bytes) !== tail[4])
      )
        fail("Portable immutable attachment changed its original content")
      return { kind: "attachment" as const, value }
    }
    if (tail.length === 2 && tail[0] === "blobs") {
      const value = BlobRecord.parse(row.value)
      if (
        value.sessionID !== header.sessionID ||
        value.owner.kind !== "session" ||
        value.owner.scopeID !== header.binding.scopeID ||
        value.owner.sessionID !== header.sessionID ||
        value.artifact.id !== tail[1]
      )
        fail("Portable content has another native artifact owner")
      return { kind: "blob" as const, value }
    }
    fail("Portable sync contains an unknown canonical key")
  }
  async function* sourceRows(header: Header) {
    if (root(header)) {
      const key = Keys.registeredRoot(header.sourceBinding.orgID, header.sessionID)
      const [value] = await Storage.readMany([key])
      if (value !== undefined) yield { key, value }
    }
    for await (const row of Storage.records({
      prefix: prefix(header),
      limit: 128,
    }))
      yield row
  }
  function checkHeader(header: Header, context: Pick<Owners.SourceContext, "handoffID" | "rootSessionID" | "session">) {
    if (
      header.binding.handoffID !== context.handoffID ||
      header.binding.sessionID !== context.session.id ||
      header.sessionID !== context.session.id ||
      header.rootSessionID !== context.rootSessionID ||
      header.binding.scopeID !== context.session.scope.id ||
      !same(header.sourceBinding, context.session.organization) ||
      (header.binding.rootSessionID ?? header.binding.sessionID) !== context.rootSessionID ||
      header.binding.fromEpoch !== header.sourceBinding.bindingEpoch ||
      header.binding.sourceID !== header.sourceBinding.driverRuntimeID
    )
      fail("Portable sync header changed its original native aggregate")
  }
  async function sourceHeader(context: Owners.SourceContext) {
    const binding = await Epochs.ownerPreparationBinding({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    const original = await nativeBinding(
      context.session.id,
      Protocol.SessionBinding.parse(context.session.organization).orgID,
      context.session.scope.id,
    )
    if (!original || original.rootSessionID !== context.rootSessionID)
      fail("Portable sync lost its canonical root binding")
    const header = Header.parse({
      version,
      binding,
      rootSessionID: context.rootSessionID,
      sessionID: context.session.id,
      sourceBinding: original.binding,
      records: 0,
      pendingBatch: null,
    })
    const [pending] = await Storage.readMany([Keys.batch(header.sourceBinding.orgID, header.sessionID)])
    if (pending !== undefined) {
      if (!root(header)) fail("Portable child has an independent root sync batch")
      header.pendingBatch = batch(pending, header).identity
    }
    for await (const row of sourceRows(header)) {
      context.signal.throwIfAborted()
      classify(row, header)
      header.records++
    }
    return Header.parse(header)
  }
  async function validateSourceArtifact(value: AttachmentRecord | BlobRecord, header: Header, signal: AbortSignal) {
    const owner =
      "scopeID" in value
        ? {
            kind: "session" as const,
            scopeID: value.scopeID,
            sessionID: value.sessionID,
          }
        : value.owner
    if (owner.kind !== "session" || owner.scopeID !== header.binding.scopeID || owner.sessionID !== header.sessionID)
      fail("Portable sync reference changed its original native artifact owner")
    const actual = await RolloutArtifact.get(owner, value.artifact.id)
    if (!same(actual, value.artifact)) fail("Portable sync reference has no exact original native artifact")
    if (actual.status !== "complete") return
    let bytes = 0
    for await (const block of RolloutArtifact.read(owner, actual)) {
      signal.throwIfAborted()
      bytes += block.byteLength
    }
    if (bytes !== actual.bytes) fail("Portable sync dependency lacks its complete original bytes")
  }
  async function* entries(context: Owners.SourceContext) {
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const header = await Storage.snapshot(() => sourceHeader(context))
    yield {
      id: JSON.stringify(headerKey(context.handoffID, context.session.id)),
      kind: "record" as const,
      metadata: { key: headerKey(context.handoffID, context.session.id) },
      content: json(header),
    }
    let records = 0
    for await (const row of sourceRows(header)) {
      context.signal.throwIfAborted()
      const selected = classify(row, header)
      if (selected.kind === "attachment" || selected.kind === "blob")
        await validateSourceArtifact(selected.value, header, context.signal)
      records++
      yield {
        id: JSON.stringify([id, row.key]),
        kind: "record" as const,
        metadata: { key: row.key },
        content: json(row.value),
      }
    }
    if (records !== header.records) fail("Portable sync changed while its native source was sealed")
  }
  async function stagedHeader(context: Owners.TargetContext) {
    const row = await context.staged.record(headerKey(context.handoffID, context.session.id))
    if (!row || context.sourceVersion !== version) fail("Portable sync lacks its owning reader")
    const header = Header.parse(row.value)
    checkHeader(header, context)
    const core = await context.staged.relatedRecord?.(
      "session-core",
      StoragePath.sessionInfo(
        Identifier.asScopeID(context.session.scope.id),
        Identifier.asSessionID(context.session.id),
      ),
    )
    if (!core) fail("Portable sync lacks its original Core metadata")
    const info = z
      .object({
        id: z.string(),
        scope: z.object({ id: z.string() }),
        organization: Protocol.SessionBinding,
      })
      .parse(core.value)
    if (
      info.id !== header.sessionID ||
      info.scope.id !== header.binding.scopeID ||
      !same(info.organization, header.sourceBinding)
    )
      fail("Portable sync and original Core metadata disagree")
    return header
  }
  const prepared = new WeakMap<
    Owners.TargetContext,
    {
      runtime: RuntimeContext.Instance
      store: ReturnType<typeof Storage.current>["store"]
      header: Header
      nativeManifestHash: string
      marker?: { assertCurrent(): void }
    }
  >()
  async function validate(context: Owners.TargetContext) {
    const header = await stagedHeader(context)
    let records = 0
    let pending = 0
    for await (const row of context.staged.records()) {
      context.signal.throwIfAborted()
      if (same(row.key, headerKey(context.handoffID, context.session.id))) continue
      const value = classify(row, header)
      records++
      if (value.kind === "draft") {
        const order = await context.staged.record(
          Keys.orderedDraft(header.sourceBinding.orgID, header.sessionID, value.value.localSequence),
        )
        if (!order || classify(order, header).kind !== "order" || !same(order.value, { draftID: value.value.draftID }))
          fail("Portable draft lacks its exact order index")
      } else if (value.kind === "order") {
        const draft = await context.staged.record(
          Keys.draft(header.sourceBinding.orgID, header.sessionID, value.value.draftID),
        )
        if (!draft || Draft.parse(draft.value).localSequence !== value.sequence)
          fail("Portable order lacks its exact draft")
      } else if (value.kind === "batch") pending++
      else if (value.kind === "attachment" || value.kind === "blob") {
        const retained = value.value
        const owner =
          "scopeID" in retained
            ? { kind: "session" as const, scopeID: retained.scopeID, sessionID: retained.sessionID }
            : retained.owner
        const dependency = await context.staged.relatedRecord?.(
          "session-core",
          RolloutArtifact.infoKey(owner, retained.artifact.id),
        )
        if (!dependency || !same(RolloutArtifact.Ref.parse(dependency.value), retained.artifact))
          fail("Portable sync dependency lacks its exact original Core artifact reference")
      }
    }
    if (records !== header.records || pending !== Number(header.pendingBatch !== null))
      fail("Portable sync closure is incomplete")
    for await (const _ of context.staged.artifacts())
      fail("Portable sync bytes must remain in their original Core owner")
    const marker = header.pendingBatch
      ? await inspectMemberSyncBatch(
          header.sourceBinding.orgID,
          { batch: header.pendingBatch, handoffID: context.handoffID },
          context.signal,
        )
      : undefined
    if (marker?.receipt.state !== undefined && marker.receipt.state !== "committed")
      fail("Portable sync batch has no exact Service receipt")
    const native = await Staging.inspect(context.handoffID)
    if (
      native.phase !== "verified" ||
      native.root.owners[id] !== version ||
      (native.root.owners["session-core"] ?? 0) < 2
    )
      fail("Portable sync requires its original verified Core manifest")
    prepared.set(context, {
      runtime: RuntimeContext.current(),
      store: Storage.current().store,
      header,
      nativeManifestHash: native.rootHash,
      marker,
    })
  }
  async function publishRows(context: Owners.TargetContext) {
    Epochs.assertActivation({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    const proof = prepared.get(context)
    if (
      !proof ||
      proof.runtime !== RuntimeContext.current() ||
      proof.store !== Storage.current().store ||
      !same(await stagedHeader(context), proof.header) ||
      (await Staging.inspect(context.handoffID)).rootHash !== proof.nativeManifestHash
    )
      fail("Portable sync requires its exact prepared owner context")
    proof.marker?.assertCurrent()
    const orgID = proof.header.sourceBinding.orgID
    const [batchRow] = proof.header.pendingBatch
      ? [await context.staged.record(Keys.batch(orgID, context.session.id))]
      : []
    const consumed = batchRow ? batch(batchRow.value, proof.header).stored : undefined
    const acknowledged = new Map(consumed?.draftIDs.map((draftID, index) => [draftID, consumed.draftHashes![index]!]))
    for await (const old of sourceRows(proof.header)) {
      classify(old, proof.header)
      if (!(await context.staged.record(old.key))) await Storage.remove(old.key)
    }
    for await (const row of context.staged.records()) {
      context.signal.throwIfAborted()
      if (same(row.key, headerKey(context.handoffID, context.session.id))) continue
      classify(row, proof.header)
      await Storage.write(row.key, row.value)
    }
    if (consumed) {
      await Storage.remove(Keys.batch(orgID, context.session.id))
      for (const [draftID, digest] of acknowledged) {
        const key = Keys.draft(orgID, context.session.id, draftID)
        const [value] = await Storage.readMany([key])
        if (value === undefined) continue
        const draft = Draft.parse(value)
        if (hash(draft.event) !== digest) continue
        await Storage.remove(key)
        await Storage.remove(Keys.orderedDraft(orgID, context.session.id, draft.localSequence))
      }
    }
    proof.marker?.assertCurrent()
  }
  async function publish(context: Owners.TargetContext) {
    const proof = prepared.get(context)
    if (!proof) fail("Portable sync has no prepared native publication context")
    await Storage.transaction(() => publishRows(context), {
      commitGuard() {
        context.signal.throwIfAborted()
        if (RuntimeContext.current() !== proof.runtime || Storage.current().store !== proof.store)
          fail("Portable sync publication lost its original Runtime or Store")
        proof.marker?.assertCurrent()
      },
    })
  }
  async function sourceHeaderFromManifest(
    value: Epochs.Binding,
    nativeManifestHash: string,
    signal: AbortSignal,
    reader: Reader,
  ) {
    const binding = Epochs.Binding.parse(value)
    Protocol.Digest.parse(nativeManifestHash)
    signal.throwIfAborted()
    const before = await Source.status(binding)
    if (!before || before.manifestHash !== nativeManifestHash)
      fail("Sync checkpoint requires its actual sealed native source")
    const header = Header.parse(
      await reader.record({
        manifestHash: nativeManifestHash,
        ownerID: id,
        key: headerKey(binding.handoffID, binding.sessionID),
      }),
    )
    if (!same(header.binding, binding) || !root(header)) fail("Sync checkpoint belongs to another sealed root")
    signal.throwIfAborted()
    if ((await Source.status(binding))?.manifestHash !== nativeManifestHash)
      fail("Sync checkpoint lost its original source package")
    return header
  }
  function checkpoint(header: Header, nativeManifestHash: string) {
    return Handoff.SyncCheckpoint.parse({
      version,
      closureHash: createHash("sha256")
        .update("synergy.organization.sync-transfer.v1\n")
        .update(JSON.stringify({ nativeManifestHash, syncHeader: header }))
        .digest("hex"),
      pendingBatch: header.pendingBatch,
    })
  }
  export async function sourceCheckpoint(
    binding: Epochs.Binding,
    nativeManifestHash: string,
    signal: AbortSignal,
    reader: Reader,
  ) {
    return checkpoint(await sourceHeaderFromManifest(binding, nativeManifestHash, signal, reader), nativeManifestHash)
  }
  export async function settleSource(
    binding: Epochs.Binding,
    nativeManifestHash: string,
    signal: AbortSignal,
    reader: Reader,
  ) {
    const header = await sourceHeaderFromManifest(binding, nativeManifestHash, signal, reader)
    const actual = await Epochs.ownerPreparationBinding({
      sessionID: binding.sessionID,
      handoffID: binding.handoffID,
    })
    if (!same(actual, binding)) fail("Sync settlement lost its finite original source preparation")
    if (header.pendingBatch) await settleMemberSync(binding, header.sourceBinding.orgID, header.pendingBatch, signal)
    signal.throwIfAborted()
    if (
      !same(
        await Epochs.ownerPreparationBinding({
          sessionID: binding.sessionID,
          handoffID: binding.handoffID,
        }),
        binding,
      )
    )
      fail("Sync settlement changed its original source epoch")
  }
  export async function stagedCheckpoint(context: Owners.TargetContext, nativeManifestHash: string) {
    Protocol.Digest.parse(nativeManifestHash)
    const proof = prepared.get(context)
    if (
      !proof ||
      proof.runtime !== RuntimeContext.current() ||
      proof.store !== Storage.current().store ||
      !root(proof.header)
    )
      fail("Sync checkpoint requires its original validated root owner")
    const actual = await Staging.inspect(context.handoffID)
    if (
      actual.phase !== "verified" ||
      actual.rootHash !== nativeManifestHash ||
      proof.nativeManifestHash !== nativeManifestHash ||
      actual.root.owners[id] !== version
    )
      fail("Sync checkpoint requires the original verified native manifest")
    return checkpoint(await stagedHeader(context), nativeManifestHash)
  }
  export function register() {
    Owners.register(id, {
      version,
      reads: [version],
      stagedDependencies: ["session-core", "organization-runtime"],
      publicationAfter: ["session-core", "organization-runtime"],
      async applies(session) {
        if (!session.organization) return false
        if (!session.parentID || (await nativeBinding(session.id, session.organization.orgID, session.scope.id)))
          return true
        return (
          (
            await Storage.query({
              prefix: ["organization-sync", session.organization.orgID, "sessions", session.id],
              limit: 1,
            })
          ).length > 0
        )
      },
      async inspect() {
        return { requirements: [], children: (async function* () {})() }
      },
      async freeze(context) {
        if (context.session.id !== context.rootSessionID) return
        const binding = await Epochs.ownerPreparationBinding({
          sessionID: context.session.id,
          handoffID: context.handoffID,
        })
        await drainMemberSync(context.session.id, binding)
      },
      async sealAggregate({ root }) {
        const binding = await Epochs.ownerPreparationBinding({ sessionID: root.session.id, handoffID: root.handoffID })
        await drainMemberSync(root.session.id, binding)
      },
      export: entries,
      validate,
      publish,
    })
  }
}
