import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { getMigrationStatus, runMigrations } from "@ericsanchezok/synergy-harness/migration"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { Batch, binding, type Bound } from "./sync-outbox"
import type { AttachmentRecord } from "./sync-projection"

const domain = "organization-sync"
const migrationID = "20261114-organization-sync-original-attachment-content-repair"
const Unknown = NamedError.create(
  "OrganizationSyncAttachmentRepairUnknown",
  z.strictObject({
    code: z.literal("UNKNOWN"),
    message: z.string(),
  }),
)
function unknown(message: string, cause?: unknown): never {
  throw new Unknown({ code: "UNKNOWN", message }, cause === undefined ? undefined : { cause })
}
interface RepairFrame {
  lease: RuntimeMaintenance.Lease
  orgID: string
  runtimeID: string
  signal?: AbortSignal
  assert(): void
  verify(): Promise<void>
  ordinary<T>(body: () => T): T
}
const request = RuntimeContext.createAsyncContext<RepairFrame>()
function original() {
  const frame = request.getStore()
  if (!frame) unknown("Original attachment repair requires its explicit native maintenance owner")
  frame.assert()
  return frame
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
async function proveBody(
  owner: RolloutArtifact.Owner,
  ref: RolloutArtifact.Ref,
  expected: { hash: string; bytes: number },
  frame: RepairFrame,
) {
  frame.assert()
  if (ref.status !== "complete" || ref.sha256 !== expected.hash || ref.bytes !== expected.bytes)
    unknown("Original attachment metadata does not match its retained batch")
  const actual = await RolloutArtifact.get(owner, ref.id)
  if (!isDeepStrictEqual(actual, ref)) unknown("Original attachment reference changed its native owner")
  let bytes = 0
  const hash = createHash("sha256")
  for await (const chunk of RolloutArtifact.read(owner, actual)) {
    frame.assert()
    bytes += chunk.byteLength
    if (bytes > expected.bytes) unknown("Original attachment body exceeds its retained batch")
    hash.update(chunk)
  }
  if (bytes !== expected.bytes || hash.digest("hex") !== expected.hash)
    unknown("Original attachment body does not match its retained batch")
  if (!isDeepStrictEqual(await RolloutArtifact.get(owner, ref.id), ref))
    unknown("Original attachment reference changed during its native verification")
  frame.assert()
}
function originalBatch(batch: Batch, rootSessionID: string) {
  if (
    batch.sessionID !== rootSessionID ||
    batch.lastSeq - batch.firstSeq + 1 !== batch.events.length ||
    !batch.events.every((event, index) => event.sequence === batch.firstSeq + index) ||
    digest({ firstSeq: batch.firstSeq, lastSeq: batch.lastSeq, events: batch.events }) !== batch.payloadHash
  )
    unknown("Original attachment batch has no exact native sequence identity")
}
async function bound(rootSessionID: string, sessionID: string, batch: Batch, frame: RepairFrame) {
  frame.assert()
  if (await Epochs.isFrozen(rootSessionID))
    unknown("Original attachment repair lacks its original frozen transfer owner")
  const selected = await binding(sessionID, frame.orgID)
  if (
    !selected ||
    selected.rootSessionID !== rootSessionID ||
    selected.binding.bindingEpoch !== batch.bindingEpoch ||
    selected.binding.driverRuntimeID !== frame.runtimeID ||
    selected.binding.projectID !== selected.session.scope.id ||
    selected.root.scope.id !== selected.session.scope.id
  )
    unknown("Original attachment batch has no current native binding or proven old-epoch lineage")
  frame.assert()
  return selected
}
function sameBinding(current: Bound, previous: Bound) {
  return (
    current.rootSessionID === previous.rootSessionID &&
    current.session.id === previous.session.id &&
    current.session.scope.id === previous.session.scope.id &&
    current.parentSessionID === previous.parentSessionID &&
    isDeepStrictEqual(current.binding, previous.binding)
  )
}
async function repair(rootSessionID: string, frame: RepairFrame) {
  const receipt = await frame.ordinary(() => RuntimeMaintenance.drain(frame.lease, { signal: frame.signal }))
  frame.assert()
  const [raw] = await Storage.readMany([Keys.batch(frame.orgID, rootSessionID)])
  if (raw === undefined) return
  const batch = Batch.parse(raw)
  originalBatch(batch, rootSessionID)
  const { AttachmentRecord: Record, retainAttachmentContent } = await import("./sync-projection")
  const root = await bound(rootSessionID, rootSessionID, batch, frame)
  const retained = new Map<
    string,
    { value: AttachmentRecord; alias: AttachmentRecord; bound: Bound; existing?: AttachmentRecord }
  >()
  for (const event of batch.events) {
    frame.assert()
    if (event.type !== "attachment" || event.state !== "available") continue
    const sourceSessionID = event.sessionID ?? rootSessionID
    const selected = await bound(rootSessionID, sourceSessionID, batch, frame)
    const [rawAlias] = await Storage.readMany([Keys.attachment(frame.orgID, sourceSessionID, event.attachmentID)])
    if (rawAlias === undefined) unknown("Original attachment repair has no native owner alias")
    const alias = Record.parse(rawAlias)
    if (
      alias.sessionID !== sourceSessionID ||
      alias.attachmentID !== event.attachmentID ||
      alias.scopeID !== selected.session.scope.id ||
      alias.artifact.status !== "complete" ||
      !alias.artifact.sha256
    )
      unknown("Original attachment alias changed its native Session or Scope")
    const owner = { kind: "session" as const, scopeID: alias.scopeID, sessionID: sourceSessionID }
    const actualAlias = await RolloutArtifact.get(owner, alias.artifact.id)
    if (!isDeepStrictEqual(actualAlias, alias.artifact))
      unknown("Original attachment alias has foreign native evidence")
    const key = Keys.attachmentContent(frame.orgID, sourceSessionID, event.attachmentID, event.hash, event.bytes)
    const [existing] = await Storage.readMany([key])
    let value: AttachmentRecord | undefined
    if (existing !== undefined) {
      value = Record.parse(existing)
      if (
        value.sessionID !== sourceSessionID ||
        value.attachmentID !== event.attachmentID ||
        value.scopeID !== alias.scopeID
      )
        unknown("Original attachment content changed its native owner")
      await proveBody(owner, value.artifact, event, frame)
    } else {
      for await (const ref of RolloutArtifact.iterate(owner, { signal: frame.signal })) {
        frame.assert()
        if (ref.status !== "complete" || ref.sha256 !== event.hash || ref.bytes !== event.bytes) continue
        await proveBody(owner, ref, event, frame)
        value = Record.parse({ ...alias, artifact: ref })
        break
      }
      if (!value) unknown("Original attachment batch has no complete same-owner native body")
    }
    retained.set(JSON.stringify(key), {
      value,
      alias,
      bound: selected,
      existing: existing === undefined ? undefined : Record.parse(existing),
    })
  }
  await frame.verify()
  const { observeNativeSyncFailure } = await import("./sync-native-source")
  await frame.ordinary(() =>
    Storage.transaction(
      async () => {
        Storage.afterFailure((error) => {
          observeNativeSyncFailure(root, error)
        })
        await RuntimeMaintenance.assertDrained(frame.lease, receipt)
        frame.assert()
        const current = await Storage.read(Keys.batch(frame.orgID, rootSessionID))
        if (!isDeepStrictEqual(current, batch)) unknown("Original attachment batch changed before native publication")
        const selected = await bound(rootSessionID, rootSessionID, batch, frame)
        if (!sameBinding(selected, root)) unknown("Original attachment root changed before native publication")
        for (const entry of retained.values()) {
          const selected = await bound(rootSessionID, entry.value.sessionID, batch, frame)
          if (!sameBinding(selected, entry.bound))
            unknown("Original attachment Session changed before native publication")
          const alias = await Storage.read(
            Keys.attachment(frame.orgID, entry.value.sessionID, entry.value.attachmentID),
          )
          if (!isDeepStrictEqual(alias, entry.alias))
            unknown("Original attachment alias changed before native publication")
          const owner = { kind: "session" as const, scopeID: entry.value.scopeID, sessionID: entry.value.sessionID }
          if (!isDeepStrictEqual(await RolloutArtifact.get(owner, entry.alias.artifact.id), entry.alias.artifact))
            unknown("Original attachment alias evidence changed before native publication")
          const key = Keys.attachmentContent(
            frame.orgID,
            entry.value.sessionID,
            entry.value.attachmentID,
            entry.value.artifact.sha256!,
            entry.value.artifact.bytes,
          )
          const [content] = await Storage.readMany([key])
          if (!isDeepStrictEqual(content, entry.existing))
            unknown("Original attachment content changed before native publication")
          if (!isDeepStrictEqual(await RolloutArtifact.get(owner, entry.value.artifact.id), entry.value.artifact))
            unknown("Original attachment reference changed before native publication")
          await retainAttachmentContent(frame.orgID, entry.value, async (key, value) => {
            await Storage.write(key, value)
          })
        }
        frame.assert()
      },
      { commitGuard: frame.assert },
    ),
  )
}
export const originalAttachmentContentRepairMigration: Migration = {
  id: migrationID,
  description: "Recover immutable original attachment references from proven native pending batches",
  scope: "global",
  execution: "maintenance",
  dependsOn: ["20261114-organization-sync-attachment-content"],
  async up(progress) {
    const frame = original()
    let count = 0
    try {
      for await (const row of Storage.records({ prefix: Keys.sessions(frame.orgID), limit: 128 })) {
        frame.assert()
        if (row.key.length !== 5 || row.key[4] !== "batch") continue
        const rootSessionID = row.key[3]!
        if (!isDeepStrictEqual(row.key, Keys.batch(frame.orgID, rootSessionID)))
          unknown("Original attachment batch changed its key")
        await repair(rootSessionID, frame)
        progress(++count, count + 1)
      }
    } catch (cause) {
      frame.signal?.throwIfAborted()
      if (Unknown.isInstance(cause)) throw cause
      unknown("Original attachment repair lacks complete native evidence", cause)
    }
    progress(count + 1, count + 1)
  },
}
export async function repairOrganizationSyncAttachmentContent(input: {
  lease: RuntimeMaintenance.Lease
  orgID: string
  signal?: AbortSignal
}) {
  const lease = input.lease
  const orgID = Identity.ID.parse(input.orgID)
  const signal = input.signal
  if (Storage.inTransaction()) unknown("Original attachment repair must own its native writer boundary")
  if (lease.purpose !== "organization-backup") unknown("Original attachment repair requires its native backup cohort")
  const runtime = RuntimeContext.current()
  const primary = runtime.storage
  const current = Storage.current()
  if (
    !primary ||
    primary.store !== current.store ||
    primary.artifactDirectory !== current.artifactDirectory ||
    primary.artifactObjects !== current.artifactObjects ||
    primary.store.options.readonly
  )
    unknown("Original attachment repair requires its actual writable native primary")
  const handle: Storage.Handle = {
    store: primary.store,
    artifactDirectory: primary.artifactDirectory,
    artifactObjects: primary.artifactObjects,
  }
  const configuration = digest(handle.store.options)
  const namespace = await NativeNamespaceIdentity.capture()
  const descriptor = NativeNamespaceIdentity.inspect(namespace)
  const runtimeID = descriptor.identity.runtimeID
  if (descriptor.owner !== "organization-runtime" || descriptor.identity.orgID !== orgID || !runtimeID)
    unknown("Original attachment repair selected another enrolled organization Home")
  const writer = await ServerProcessLock.currentOwnership()
  const home = runtime.host.home
  const root = runtime.host.root
  const objects = primary.artifactObjects
  const objectConfig = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
  using lock = signal
    ? await Lock.writeWithSignal("organization-sync-attachment-repair", signal)
    : await Lock.write("organization-sync-attachment-repair")
  let active = true
  const frame: RepairFrame = {
    lease,
    orgID,
    runtimeID,
    signal,
    assert() {
      signal?.throwIfAborted()
      if (
        !active ||
        request.getStore() !== frame ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        runtime.host.home !== home ||
        runtime.host.root !== root ||
        Storage.current().store !== handle.store ||
        digest(handle.store.options) !== configuration ||
        Storage.current().artifactDirectory !== handle.artifactDirectory ||
        Storage.current().artifactObjects !== handle.artifactObjects ||
        !handle.store.readiness.readerReady ||
        !handle.store.readiness.writerReady ||
        objects?.blobs !== objectConfig?.blobs ||
        objects?.writerID !== objectConfig?.writerID ||
        objects?.now !== objectConfig?.now
      )
        unknown("Original attachment repair lost its native callback, primary or Home")
      ServerProcessLock.assertCurrent(writer)
      if (!isDeepStrictEqual(NativeNamespaceIdentity.inspect(namespace), descriptor))
        unknown("Original attachment repair changed its enrolled native namespace")
    },
    async verify() {
      frame.assert()
      await NativeNamespaceIdentity.verify(namespace)
      await ServerProcessLock.verifyOwnership(writer)
      frame.assert()
    },
    ordinary<T>(body: () => T): T {
      return Storage.provide(handle, body)
    },
  }
  try {
    return await request.run(frame, async () => {
      frame.assert()
      await frame.ordinary(() => RuntimeMaintenance.assertDraining(lease))
      await NativeNamespaceIdentity.verify(namespace)
      await ServerProcessLock.verifyOwnership(writer)
      await frame.ordinary(() => RuntimeMaintenance.drain(lease, { signal }))
      const status = await getMigrationStatus(domain)
      const registered = status[domain]
      if (
        !registered ||
        ![...registered.completed, ...registered.pending].some((migration) => migration.id === migrationID) ||
        registered.pending.some((migration) => migration.id !== migrationID)
      )
        unknown("Original attachment repair requires completed native startup migrations")
      return runMigrations({ targetDomain: domain, maintenance: true, output: "silent", signal })
    })
  } finally {
    active = false
  }
}
