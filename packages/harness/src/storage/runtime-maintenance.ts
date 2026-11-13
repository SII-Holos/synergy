import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { HomeRestoration } from "../lifecycle/home-restoration"
import { HomeOwnershipFile } from "../lifecycle/home-ownership-file"
import { ServerProcessLock } from "../util/server-process-lock"
import { Lock } from "../util/lock"
import { Storage } from "./storage"
import { StorageMutationGuard } from "./mutation-guard"
import { StorageCheckpoint } from "./checkpoint"
import { RuntimeMaintenanceSchema as Schema } from "./runtime-maintenance-schema"
import { MaintenanceRetirementRecords as Retirements } from "./maintenance-retirement-records"
import type { StoreTransaction, TransactionOptions } from "./transactional-store"
import type { VaultKeyProvider } from "../secrets/encrypted-store"

const ID = z.string().min(1).max(128)
const Count = z.number().int().nonnegative().safe()
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const root = ["runtime_maintenance"]
const currentKey = [...root, "current"]
const operationKey = (id: string) => [...root, "operations", id]
const requestKey = (id: string) => [...root, "requests", id]
const ownerKey = (id: string, owner: string) => [...root, "owners", id, owner]
const restorationKey = (installationID: string) => [...root, "restorations", installationID]
const startsWith = (key: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => key[index] === part)
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Operator = Schema.Operator
const mutation = RuntimeContext.createAsyncContext<{
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
}>()
const restorationWrites = RuntimeContext.createAsyncContext<{
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
  transaction: StoreTransaction
  permit: HomeRestoration.InstallPermit
  request: HomeRestoration.Request
  open: boolean
}>()
const restorationArtifacts = RuntimeContext.createAsyncContext<StorageCheckpoint.PreparedArtifacts>()
const frozenWork = RuntimeContext.createAsyncContext<{
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
  lease: RuntimeMaintenance.Lease
  signal: AbortSignal
  open: boolean
}>()
function mutate<T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) {
  return mutation.run({ runtime: RuntimeContext.current(), store: Storage.current().store }, () =>
    Storage.transaction(body, options),
  )
}

export namespace RuntimeMaintenance {
  export const Purpose = Schema.Purpose
  export type Purpose = z.infer<typeof Purpose>
  export const Requirement = z.strictObject({
    code: ID,
    owner: ID,
    label: z.string().min(1).max(1024),
    recoverable: z.boolean(),
  })
  export type Requirement = z.infer<typeof Requirement>
  export const Blocked = NamedError.create(
    "RuntimeMaintenanceBlocked",
    z.object({ message: z.string(), maintenanceID: ID.optional(), requirements: z.array(Requirement).optional() }),
  )
  export const Info = Schema.Info
  export type Info = z.infer<typeof Info>
  export const Restoration = z.strictObject({
    version: z.literal(1),
    installationID: z.uuid(),
    incarnation: z.uuid(),
    restoreID: ID,
    requestHash: Hash,
    sourceHash: Hash,
    source: Info,
    target: Info,
  })
  export type Restoration = z.infer<typeof Restoration>
  export interface Lease {
    readonly maintenanceID: string
    readonly purpose: Purpose
  }
  export interface DrainReceipt {
    readonly maintenanceID: string
  }
  export interface Context {
    lease: Lease
    maintenanceID: string
    purpose: Purpose
    signal: AbortSignal
  }
  export interface Contribution {
    version: number
    order?: number
    suspend(context: Context): Promise<void>
    drain(context: Context): Promise<void>
    inspect(context: Context): Promise<Requirement[]>
    release(context: Context): Promise<void>
    released?(context: Context): Promise<void>
    reconcileFrozen?(context: Context): Promise<void>
  }
  interface LeaseIdentity {
    runtime: RuntimeContext.Instance
    store: Storage.Handle["store"]
    maintenanceID: string
    cohortHash: string
    resumed?: { source: Info; referenceHash: string; assert(): void }
  }
  interface ReceiptIdentity extends LeaseIdentity {
    revision: number
    tailRevision: number
  }
  const leases = new WeakMap<Lease, LeaseIdentity>()
  const receipts = new WeakMap<DrainReceipt, ReceiptIdentity>()
  const state = RuntimeContext.state(() => ({
    required: undefined as string[] | undefined,
    owners: new Map<string, Contribution>(),
    installed: false,
    pending: false,
    retirementSource: undefined as
      | {
          inspect(evidence: object): {
            source: Info
            marker: HomeOwnershipFile.RetirementInfo
            configurationHash: string
          }
        }
      | undefined,
  }))

  async function read<T>(tx: StoreTransaction, schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
    const [value] = await tx.readMany([key])
    return value === undefined ? undefined : schema.parse(value)
  }
  async function current(tx: StoreTransaction) {
    const pointer = await read(tx, z.strictObject({ maintenanceID: ID }), currentKey)
    if (!pointer) {
      if ((await tx.queryKeys({ prefix: root, limit: 1 })).length)
        throw new Blocked({ message: "Maintenance history has no current operation pointer" })
      return
    }
    const [value, retirement] = await tx.readMany([
      operationKey(pointer.maintenanceID),
      Retirements.key(pointer.maintenanceID),
    ])
    const info = value === undefined ? undefined : Info.parse(value)
    if (!info || info.maintenanceID !== pointer.maintenanceID)
      throw new Blocked({ message: "Maintenance operation is missing or inconsistent" })
    if (
      retirement !== undefined &&
      digest(Retirements.parse(Retirements.key(pointer.maintenanceID), retirement).source) !== digest(info)
    )
      throw new Blocked({ message: "Source retirement no longer matches its frozen maintenance history" })
    return info
  }
  function owners() {
    const selected = state()
    if (!selected.required?.length)
      throw new Blocked({ message: "Maintenance requires its selected native writer cohort" })
    const missing = selected.required.filter((id) => !selected.owners.has(id))
    if (missing.length)
      throw new Blocked({
        message: "A required maintenance owner is unavailable",
        requirements: missing.map((owner) => ({
          owner,
          code: "maintenance_owner_missing",
          label: `Install the ${owner} native maintenance owner`,
          recoverable: true,
        })),
      })
    return [...selected.owners].sort(
      ([left, a], [right, b]) => (a.order ?? 0) - (b.order ?? 0) || (left < right ? -1 : left > right ? 1 : 0),
    )
  }
  function cohortHash() {
    return digest({
      required: state().required,
      owners: owners().map(([id, owner]) => ({ id, version: owner.version, order: owner.order ?? 0 })),
    })
  }
  function install() {
    if (state().installed) return
    StorageMutationGuard.register("runtime-maintenance", async (tx, keys, tree) => {
      const reserved = keys.filter((key) => startsWith(key, root) || (tree && startsWith(root, key)))
      if (reserved.length) {
        const owner = mutation.getStore()
        if (
          owner?.runtime !== RuntimeContext.current() ||
          owner.store !== Storage.current().store ||
          reserved.some((key) => !startsWith(key, root))
        )
          throw new Blocked({ message: "Maintenance operation records require their native owner" })
        if (reserved.length === keys.length) return
      }
      const info = await current(tx)
      if (!info || info.phase === "released") return
      if (info.phase === "draining" || info.phase === "releasing") {
        await mutation.run({ runtime: RuntimeContext.current(), store: Storage.current().store }, () =>
          tx.write(
            operationKey(info.maintenanceID),
            Info.parse({ ...info, tailRevision: info.tailRevision + 1, updatedAt: Date.now() }),
          ),
        )
        return
      }
      const recovery = restorationWrites.getStore()
      if (info.phase === "recovery-held" && recovery) {
        if (
          !recovery.open ||
          recovery.runtime !== RuntimeContext.current() ||
          recovery.store !== Storage.current().store ||
          recovery.transaction !== tx
        )
          throw new Blocked({ message: "Recovery history writes require their original native transaction callback" })
        HomeRestoration.assertCurrent(recovery.permit)
        HomeRestoration.assertInstalledOwner(recovery.permit)
        HomeRestoration.assertRequest(recovery.permit, recovery.request)
        recovery.store.assertWriteTransaction(tx)
        return
      }
      throw new Blocked({
        maintenanceID: info.maintenanceID,
        message: "Maintenance freezes ordinary canonical mutations",
      })
    })
    state().installed = true
  }
  export function registerProtection() {
    RuntimeContext.assertCompositionOpen("Runtime maintenance protection")
    install()
  }
  export function configure(input: { required: readonly string[] }) {
    RuntimeContext.assertCompositionOpen("Runtime maintenance cohort")
    if (state().required) throw new Blocked({ message: "Runtime maintenance cohort is already configured" })
    const required = input.required.map((id) => ID.parse(id)).sort()
    if (!required.length || new Set(required).size !== required.length)
      throw new Blocked({ message: "Maintenance must declare unique required native owners" })
    state().required = required
    install()
  }
  export function register(id: string, owner: Contribution) {
    RuntimeContext.assertCompositionOpen("Runtime maintenance owners")
    ID.parse(id)
    Count.positive().parse(owner.version)
    z.number()
      .int()
      .safe()
      .parse(owner.order ?? 0)
    if (state().owners.has(id)) throw new Blocked({ message: "Maintenance owner is already registered" })
    state().owners.set(id, { ...owner })
    install()
  }
  export function hasOwner(id: string) {
    ID.parse(id)
    return state().owners.has(id)
  }
  function identity(lease: Lease) {
    const value = leases.get(lease)
    if (!value || value.runtime !== RuntimeContext.current() || value.store !== Storage.current().store)
      throw new Blocked({ message: "Maintenance lease belongs to another Runtime or namespace" })
    if (value.cohortHash !== cohortHash()) throw new Blocked({ message: "Maintenance writer cohort changed" })
    value.resumed?.assert()
    return value
  }
  async function requireCurrent(tx: StoreTransaction, lease: Lease) {
    const held = identity(lease)
    const info = await current(tx)
    if (
      !info ||
      info.maintenanceID !== held.maintenanceID ||
      info.sourceRuntimeID !== (held.resumed?.source.sourceRuntimeID ?? held.runtime.id) ||
      (held.resumed && digest(info) !== digest(held.resumed.source)) ||
      info.cohortHash !== held.cohortHash
    )
      throw new Blocked({ message: "Maintenance lease is no longer the current native operation" })
    return info
  }
  export function status() {
    return Storage.snapshot(current)
  }
  export async function operation(maintenanceID: string) {
    ID.parse(maintenanceID)
    return Storage.snapshot((tx) => read(tx, Info, operationKey(maintenanceID)))
  }
  export function restoration(installationID: string) {
    z.uuid().parse(installationID)
    return Storage.snapshot((tx) => read(tx, Restoration, restorationKey(installationID)))
  }
  export function retirement(maintenanceID: string) {
    ID.parse(maintenanceID)
    return Retirements.read(maintenanceID)
  }
  export function registerRetirementSource(
    ownerID: string,
    owner: NonNullable<ReturnType<typeof state>["retirementSource"]>,
  ) {
    RuntimeContext.assertCompositionOpen("Frozen retirement source")
    if (!state().owners.has(ownerID) || state().retirementSource)
      throw new Blocked({ message: "Frozen retirement requires its single installed maintenance owner" })
    state().retirementSource = { inspect: owner.inspect.bind(owner) }
  }
  export async function withRetirementSource<T>(
    input: { evidence: object; signal?: AbortSignal },
    body: (lease: Lease) => Promise<T>,
  ) {
    if (Storage.inTransaction()) throw new Blocked({ message: "Cold retirement requires its native boundary" })
    const owner = state().retirementSource
    if (!owner) throw new Blocked({ message: "Cold retirement requires its installed Current owner" })
    const selected = owner.inspect(input.evidence)
    const source = Info.parse(structuredClone(selected.source))
    const marker = HomeOwnershipFile.RetirementInfo.parse(structuredClone(selected.marker))
    const configurationHash = Hash.parse(selected.configurationHash)
    const signal = input.signal
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const configuration = digest(store.options)
    if (
      source.phase !== "frozen" ||
      source.purpose !== "organization-backup" ||
      marker.maintenanceID !== source.maintenanceID ||
      configuration !== configurationHash ||
      store.options.backend !== "sqlite" ||
      store.options.readonly ||
      primary.artifactObjects ||
      source.cohortHash !== cohortHash()
    )
      throw new Blocked({ message: "Cold retirement requires its exact frozen native source" })
    const writer = await ServerProcessLock.currentOwnership()
    const files = HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env, selected: marker })
    let open = true
    const assert = () => {
      signal?.throwIfAborted()
      if (
        !open ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== artifacts ||
        Storage.current().artifactObjects ||
        primary.store !== store ||
        digest(store.options) !== configuration ||
        primary.artifactObjects ||
        primary.artifactDirectory !== artifacts
      )
        throw new Blocked({ message: "Cold retirement native source callback changed" })
      ServerProcessLock.assertCurrent(writer)
      const current = owner.inspect(input.evidence)
      if (
        digest(current.source) !== digest(source) ||
        digest(current.marker) !== digest(marker) ||
        current.configurationHash !== configurationHash
      )
        throw new Blocked({ message: "Cold retirement Current evidence changed" })
    }
    const artifacts = primary.artifactDirectory
    const lease: Lease = Object.freeze({ maintenanceID: source.maintenanceID, purpose: source.purpose })
    leases.set(lease, {
      runtime,
      store,
      maintenanceID: source.maintenanceID,
      cohortHash: source.cohortHash,
      resumed: { source, referenceHash: marker.referenceHash, assert },
    })
    const verify = async () => {
      assert()
      await ServerProcessLock.verifyOwnership(writer)
      if (
        (await files.physicalHash()) !== marker.physicalHash ||
        (await files.inspectRetirement(marker.source)) !== "source"
      )
        throw new Blocked({ message: "Cold retirement requires its original unfenced physical Home" })
      await Storage.snapshot(async (tx) => {
        if (digest(await requireCurrent(tx, lease)) !== digest(source))
          throw new Blocked({ message: "Cold retirement frozen operation changed" })
        const request = await read(
          tx,
          z.strictObject({ maintenanceID: ID, requestHash: Hash }),
          requestKey(source.requestID),
        )
        if (request?.maintenanceID !== source.maintenanceID || request.requestHash !== source.requestHash)
          throw new Blocked({ message: "Cold retirement has no original maintenance request" })
        for (const [id, owner] of owners()) {
          const retained = await read(
            tx,
            z.strictObject({
              version: z.literal(1),
              ownerID: ID,
              ownerVersion: Count,
              phase: z.literal("drained"),
              tailRevision: Count,
            }),
            ownerKey(source.maintenanceID, id),
          )
          if (
            !retained ||
            retained.ownerID !== id ||
            retained.ownerVersion !== owner.version ||
            retained.tailRevision !== source.tailRevision
          )
            throw new Blocked({ message: "Cold retirement has no original owner drainage" })
        }
      })
      assert()
    }
    try {
      await verify()
      const currentContext = context(lease, signal)
      for (const [, owner] of owners()) {
        if (!owner.reconcileFrozen)
          throw new Blocked({ message: "A frozen writer has no native cold reconciliation owner" })
        await owner.reconcileFrozen(currentContext)
      }
      await inspectOwners(currentContext)
      await verify()
      return await body(lease)
    } finally {
      open = false
      leases.delete(lease)
    }
  }
  export async function reserveRetirement(lease: Lease, value: string) {
    const referenceHash = Hash.parse(value)
    const resumed = identity(lease).resumed
    if (resumed && resumed.referenceHash !== referenceHash)
      throw new Blocked({ message: "Cold retirement cannot reserve another reference" })
    const frame = frozenWork.getStore()
    const assert = () => {
      if (
        !frame?.open ||
        frame.lease !== lease ||
        frame.runtime !== RuntimeContext.current() ||
        frame.store !== Storage.current().store
      )
        throw new Blocked({ message: "Source retirement requires its original frozen callback" })
      frame.signal.throwIfAborted()
      identity(lease)
    }
    assert()
    return mutate(
      async (tx) => {
        assert()
        const source = await requireCurrent(tx, lease)
        if (source.purpose !== "organization-backup" || source.phase !== "frozen")
          throw new Blocked({ message: "Source retirement requires its actual frozen operation" })
        const expected = Retirements.Info.parse({ version: 1, source, referenceHash })
        const retained = await Retirements.read(lease.maintenanceID)
        assert()
        if (retained) {
          if (digest(retained) !== digest(expected))
            throw new Blocked({ message: "Source retirement is reserved for another original reference" })
          return retained
        }
        await Storage.write(Retirements.key(lease.maintenanceID), expected)
        return expected
      },
      { commitGuard: assert },
    )
  }
  async function requireRestoration(tx: StoreTransaction, target: HomeRestoration.Info) {
    const retained = await read(tx, Restoration, restorationKey(target.installationID))
    const held = await current(tx)
    if (
      !retained ||
      retained.installationID !== target.installationID ||
      retained.incarnation !== target.incarnation ||
      retained.restoreID !== target.restoreID ||
      retained.requestHash !== target.requestHash ||
      retained.sourceHash !== target.sourceHash ||
      retained.source.purpose !== "organization-backup" ||
      retained.source.phase !== "frozen" ||
      held?.maintenanceID !== target.installationID ||
      held.purpose !== "organization-restore" ||
      held.requestHash !== target.requestHash ||
      held?.phase !== "recovery-held" ||
      digest(held) !== digest(retained.target)
    )
      throw new Blocked({ message: "Recovery history requires its original retained native installation" })
    const source = await read(tx, Info, operationKey(retained.source.maintenanceID))
    if (digest(source) !== digest(retained.source))
      throw new Blocked({ message: "Archived maintenance history changed" })
    return retained
  }
  export async function restorationTransaction<T>(
    input: { permit: HomeRestoration.InstallPermit; request: HomeRestoration.Request },
    body: (tx: StoreTransaction) => Promise<T>,
    options?: Omit<TransactionOptions, "operationID" | "requestHash">,
  ): Promise<T> {
    if (Storage.inTransaction())
      throw new Blocked({ message: "Recovery history must open its own native write transaction" })
    if (options && ("operationID" in options || "requestHash" in options))
      throw new Blocked({ message: "Recovery history idempotency belongs to its domain publication receipt" })
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const selected = options && { ...options }
    const externalGuard = selected?.commitGuard
    const runtime = RuntimeContext.current()
    const store = Storage.current().store
    const assertNative = () => {
      selected?.signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      if (!state().installed || RuntimeContext.current() !== runtime || Storage.current().store !== store)
        throw new Blocked({ message: "Recovery history requires its original protected Runtime and Store" })
    }
    assertNative()
    await HomeRestoration.verifyInstalledOwner(permit)
    assertNative()
    const target = HomeRestoration.describe(permit)
    return Storage.transaction(
      async (tx) => {
        assertNative()
        HomeRestoration.assertInstalledOwner(permit)
        await requireRestoration(tx, target)
        assertNative()
        const frame = { runtime, store, transaction: tx, permit, request, open: true }
        try {
          return await restorationWrites.run(frame, async () => {
            const prepared = restorationArtifacts.getStore()
            if (prepared) await StorageCheckpoint.guardPreparedArtifacts(prepared, tx)
            return body(tx)
          })
        } finally {
          frame.open = false
        }
      },
      {
        ...selected,
        commitGuard() {
          externalGuard?.()
          assertNative()
          HomeRestoration.assertInstalledOwner(permit)
        },
      },
    )
  }
  export async function withRestorationArtifacts<T>(
    input: {
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
      base: StorageCheckpoint.Manifest
      namespace: { directory: string; expected: StorageCheckpoint.Manifest }
      keys: VaultKeyProvider
      references: AsyncIterable<string[]> | Iterable<string[]>
      signal?: AbortSignal
    },
    body: (prepared: StorageCheckpoint.PreparedArtifacts) => Promise<T>,
  ): Promise<T> {
    if (Storage.inTransaction() || restorationArtifacts.getStore())
      throw new Blocked({ message: "Recovery artifact preparation requires its independent native boundary" })
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const base = StorageCheckpoint.Manifest.parse(structuredClone(input.base))
    const namespace = {
      directory: input.namespace.directory,
      expected: StorageCheckpoint.Manifest.parse(structuredClone(input.namespace.expected)),
    }
    const signal = input.signal
    const target = HomeRestoration.describe(permit)
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const configuration = digest(store.options)
    const artifacts = primary.artifactDirectory
    const assert = () => {
      signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      HomeRestoration.assertInstalledOwner(permit)
      if (
        !state().installed ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        Storage.current().store !== store ||
        primary.store !== store ||
        digest(store.options) !== configuration ||
        Storage.current().artifactDirectory !== artifacts ||
        primary.artifactDirectory !== artifacts ||
        Storage.current().artifactObjects ||
        primary.artifactObjects
      )
        throw new Blocked({ message: "Recovery artifact preparation requires its original protected primary Store" })
      if (digest(base) !== target.sourceHash || namespace.expected.namespaceID !== base.namespaceID)
        throw new Blocked({ message: "Recovery artifacts require their original H0 checkpoint namespace" })
    }
    assert()
    await HomeRestoration.verifyInstalledOwner(permit)
    await Storage.snapshot((tx) => requireRestoration(tx, target))
    const receipt = await store.operationReceipt(`storage-checkpoint:${request.restoreID}`)
    assert()
    if (!receipt || receipt.requestHash !== base.records.sha256)
      throw new Blocked({ message: "Recovery artifacts require the actual original committed H0 import" })
    return StorageCheckpoint.withPreparedArtifacts(
      {
        ...namespace,
        keys: input.keys,
        permit,
        request,
        restoreID: request.restoreID,
        installationID: target.installationID,
        bindingHash: digest({ target, request, base, namespace: namespace.expected }),
        references: input.references,
        signal,
        transaction: (body) => restorationTransaction({ permit, request }, body, { signal, commitGuard: assert }),
      },
      (prepared) => restorationArtifacts.run(prepared, () => body(prepared)),
    )
  }
  export async function adoptRestoration(
    tx: StoreTransaction,
    input: {
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
      archive: StorageCheckpoint.ImportEvidence
    },
  ): Promise<Info> {
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const archive = input.archive
    const target = HomeRestoration.describe(permit)
    const store = Storage.current().store
    const runtime = RuntimeContext.current()
    const assertNative = () => {
      if (!state().installed)
        throw new Blocked({ message: "Recovery requires its registered native maintenance protection" })
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertInstalledOwner(permit)
      HomeRestoration.assertRequest(permit, request)
      if (RuntimeContext.current() !== runtime || Storage.current().store !== store)
        throw new Blocked({ message: "Maintenance adoption belongs to another native target" })
    }
    const assert = () => {
      assertNative()
      store.assertWriteTransaction(tx)
      const manifest = StorageCheckpoint.assertImport(archive, tx)
      if (
        archive.restoreID !== target.restoreID ||
        digest(StorageCheckpoint.Manifest.parse(manifest)) !== target.sourceHash
      )
        throw new Blocked({ message: "Maintenance adoption belongs to another original namespace restoration" })
    }
    assert()
    StorageCheckpoint.guardImport(archive, tx, assertNative)
    const previous = await current(tx)
    assert()
    const retained = await read(tx, Restoration, restorationKey(target.installationID))
    assert()
    if (retained) {
      await requireRestoration(tx, target)
      assert()
      return retained.target
    }
    if (!previous || previous.purpose !== "organization-backup" || previous.phase !== "frozen")
      throw new Blocked({ message: "Recovery requires the actual imported frozen source operation" })
    if (
      previous.maintenanceID === target.installationID ||
      (await read(tx, Info, operationKey(target.installationID))) ||
      (await tx.readMany([requestKey(target.installationID)]))[0] !== undefined
    )
      throw new Blocked({ message: "Recovery cannot replace an archived maintenance identity" })
    assert()
    const now = Date.now()
    const held = Info.parse({
      version: 1,
      maintenanceID: target.installationID,
      requestID: target.installationID,
      requestHash: target.requestHash,
      purpose: "organization-restore",
      sourceRuntimeID: runtime.id,
      cohortHash: digest({
        purpose: "organization-restore",
        installationID: target.installationID,
        requestHash: target.requestHash,
        sourceCohortHash: previous.cohortHash,
      }),
      phase: "recovery-held",
      revision: 1,
      tailRevision: 0,
      actor: {
        kind: "system",
        subjectID: target.installationID,
        displayName: "Native recovery",
        clientKind: "system",
        requestID: target.installationID,
      },
      createdAt: now,
      updatedAt: now,
    })
    const reference = Restoration.parse({
      version: 1,
      installationID: target.installationID,
      incarnation: target.incarnation,
      restoreID: target.restoreID,
      requestHash: target.requestHash,
      sourceHash: target.sourceHash,
      source: previous,
      target: held,
    })
    for (const [key, value] of [
      [operationKey(held.maintenanceID), held],
      [requestKey(held.requestID), { maintenanceID: held.maintenanceID, requestHash: held.requestHash }],
      [restorationKey(target.installationID), reference],
      [currentKey, { maintenanceID: held.maintenanceID }],
    ] as const) {
      assert()
      await tx.write([...key], value)
      assert()
    }
    return held
  }
  export async function assertMutation() {
    const info = await status()
    if (info && !["released", "draining", "releasing"].includes(info.phase))
      throw new Blocked({
        maintenanceID: info.maintenanceID,
        message: "Maintenance freezes ordinary canonical mutations",
      })
  }
  export async function releaseRestoration(permit: HomeRestoration.PublicationPermit) {
    if (Storage.inTransaction())
      throw new Blocked({ message: "Publication release must own its final native transaction" })
    HomeRestoration.assertPublication(permit)
    const status = await HomeRestoration.verifyPublication(permit)
    const { installation } = HomeRestoration.describePublication(permit)
    if (installation.phase !== "completed" || !status.nativeReady)
      throw new Blocked({ message: "Restored execution requires its completed native publication" })
    using _lock = await Lock.write("runtime-maintenance")
    const assert = () => {
      HomeRestoration.assertPublication(permit)
      if (!state().installed) throw new Blocked({ message: "Publication requires its native maintenance protection" })
    }
    assert()
    const released = await mutate(
      async (tx) => {
        assert()
        const retained = await read(tx, Restoration, restorationKey(installation.installationID))
        const held = await current(tx)
        if (
          !retained ||
          !held ||
          retained.installationID !== installation.installationID ||
          retained.incarnation !== installation.incarnation ||
          retained.restoreID !== installation.restoreID ||
          retained.requestHash !== installation.requestHash ||
          retained.sourceHash !== installation.sourceHash ||
          digest(await read(tx, Info, operationKey(retained.source.maintenanceID))) !== digest(retained.source)
        )
          throw new Blocked({ message: "Publication requires its original retained maintenance adoption" })
        if (held.phase === "released") {
          if (
            digest(held) !==
            digest({
              ...retained.target,
              phase: "released",
              revision: retained.target.revision + 1,
              updatedAt: held.updatedAt,
            })
          )
            throw new Blocked({ message: "Published maintenance release has another original target" })
          return held
        }
        await requireRestoration(tx, installation)
        const result = Info.parse({ ...held, phase: "released", revision: held.revision + 1, updatedAt: Date.now() })
        await tx.write(operationKey(held.maintenanceID), result)
        return result
      },
      { commitGuard: assert },
    )
    state().pending = false
    return released
  }
  export async function assertDraining(lease: Lease) {
    const info = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (info.phase !== "draining")
      throw new Blocked({ message: "Native suspension requires its current draining operation" })
    return info
  }
  export async function assertHeld(lease: Lease) {
    const info = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (!["draining", "frozen", "releasing"].includes(info.phase))
      throw new Blocked({ message: "Native owner inspection requires its current retained operation" })
    return info
  }
  export async function assertReleasing(lease: Lease) {
    const info = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (info.phase !== "releasing" || info.purpose !== "organization-backup")
      throw new Blocked({ message: "Native source release requires its current releasing backup operation" })
    return info
  }
  export async function assertReleased(lease: Lease) {
    const info = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (info.phase !== "released" || info.purpose !== "organization-backup")
      throw new Blocked({ message: "Native admission requires its confirmed released backup operation" })
    return info
  }
  export async function withFrozen<T>(
    lease: Lease,
    body: (context: Context) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (Storage.inTransaction())
      throw new Blocked({ message: "Frozen native work must own its lifetime outside a storage transaction" })
    identity(lease)
    using held = options.signal
      ? await Lock.writeWithSignal("runtime-maintenance", options.signal)
      : await Lock.write("runtime-maintenance")
    const assertFrozen = async () => {
      const info = await assertHeld(lease)
      if (info.phase !== "frozen")
        throw new Blocked({ message: "Native protected work requires its current frozen operation" })
    }
    await assertFrozen()
    const currentContext = context(lease, options.signal)
    currentContext.signal.throwIfAborted()
    const frame = {
      runtime: RuntimeContext.current(),
      store: Storage.current().store,
      lease,
      signal: currentContext.signal,
      open: true,
    }
    try {
      const result = await frozenWork.run(frame, () => body(currentContext))
      currentContext.signal.throwIfAborted()
      await assertFrozen()
      return result
    } finally {
      frame.open = false
    }
  }
  export async function assertAdmission() {
    const info = await status()
    if (state().pending || (info && info.phase !== "released"))
      throw new Blocked({
        maintenanceID: info?.maintenanceID,
        message: "Runtime maintenance holds new execution admission",
      })
  }
  export async function begin(input: {
    purpose: Purpose
    requestID: string
    actor: ActorStamp.Info
    signal?: AbortSignal
  }): Promise<Lease> {
    if (Storage.inTransaction()) throw new Blocked({ message: "Maintenance must own its native commit boundary" })
    const purpose = Purpose.parse(input.purpose)
    const requestID = ID.parse(input.requestID)
    const actor = Operator.parse(input.actor)
    if (actor.requestID !== requestID) throw new Blocked({ message: "Maintenance actor must bind its logical request" })
    const contract = cohortHash()
    const requestHash = digest({ purpose, requestID, actor, cohortHash: contract })
    const maintenanceID = randomUUID()
    input.signal?.throwIfAborted()
    state().pending = true
    try {
      using lock = input.signal
        ? await Lock.writeWithSignal("runtime-maintenance", input.signal)
        : await Lock.write("runtime-maintenance")
      const info = await mutate(
        async (tx) => {
          input.signal?.throwIfAborted()
          const previous = await read(
            tx,
            z.strictObject({ maintenanceID: ID, requestHash: Hash }),
            requestKey(requestID),
          )
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw new Blocked({ message: "Maintenance request identity has different parameters" })
            const retained = await read(tx, Info, operationKey(previous.maintenanceID))
            if (!retained) throw new Blocked({ message: "Maintenance receipt has no native operation" })
            return retained
          }
          const prior = await current(tx)
          if (prior && prior.phase !== "released")
            throw new Blocked({
              maintenanceID: prior.maintenanceID,
              message: "Another maintenance operation is still held",
            })
          const info = Info.parse({
            version: 1,
            maintenanceID,
            requestID,
            requestHash,
            purpose,
            sourceRuntimeID: RuntimeContext.current().id,
            cohortHash: contract,
            phase: "draining",
            revision: 1,
            tailRevision: 0,
            actor,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          await tx.write(operationKey(maintenanceID), info)
          await tx.write(currentKey, { maintenanceID })
          await tx.write(requestKey(requestID), { maintenanceID, requestHash })
          return info
        },
        {
          operationID: `runtime-maintenance-begin:${digest(requestID)}`,
          requestHash,
          commitGuard: () => input.signal?.throwIfAborted(),
        },
      )
      const latest = await status()
      state().pending = latest !== undefined && latest.phase !== "released"
      if (info.sourceRuntimeID !== RuntimeContext.current().id)
        throw new Blocked({
          maintenanceID: info.maintenanceID,
          message: "A prior Runtime's maintenance requires actual writer reconciliation",
        })
      const lease = Object.freeze({ maintenanceID: info.maintenanceID, purpose: info.purpose })
      leases.set(lease, {
        runtime: RuntimeContext.current(),
        store: Storage.current().store,
        maintenanceID: info.maintenanceID,
        cohortHash: contract,
      })
      return lease
    } catch (error) {
      if (!(error instanceof Storage.CommitUnknownError)) {
        try {
          const latest = await status()
          state().pending = latest !== undefined && latest.phase !== "released"
        } catch {
          state().pending = true
        }
      }
      throw error
    }
  }
  async function inspectOwners(context: Context) {
    const requirements: Requirement[] = []
    for (const [id, owner] of owners()) {
      context.signal.throwIfAborted()
      for (const requirement of await owner.inspect(context)) {
        const value = Requirement.parse(requirement)
        if (value.owner !== id) throw new Blocked({ message: "Maintenance requirement claimed another native owner" })
        requirements.push(value)
      }
    }
    if (requirements.length)
      throw new Blocked({
        maintenanceID: context.maintenanceID,
        message: "Native writers require reconciliation before maintenance can complete",
        requirements,
      })
  }
  function context(lease: Lease, signal?: AbortSignal): Context {
    identity(lease)
    return {
      lease,
      maintenanceID: lease.maintenanceID,
      purpose: lease.purpose,
      signal: signal ?? new AbortController().signal,
    }
  }
  export async function drain(lease: Lease, options: { signal?: AbortSignal } = {}): Promise<DrainReceipt> {
    if (identity(lease).resumed) throw new Blocked({ message: "Cold retirement cannot establish another drainage" })
    using lock = options.signal
      ? await Lock.writeWithSignal("runtime-maintenance", options.signal)
      : await Lock.write("runtime-maintenance")
    const initial = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (initial.phase !== "draining")
      throw new Blocked({ message: "Only a draining native operation can establish its freeze receipt" })
    const currentContext = context(lease, options.signal)
    for (const [, owner] of owners()) {
      currentContext.signal.throwIfAborted()
      await owner.suspend(currentContext)
    }
    for (const [, owner] of owners()) {
      currentContext.signal.throwIfAborted()
      await owner.drain(currentContext)
    }
    await inspectOwners(currentContext)
    const info = await mutate(async (tx) => {
      const info = await requireCurrent(tx, lease)
      if (info.phase !== "draining")
        throw new Blocked({ message: "Maintenance phase changed while its native owners drained" })
      for (const [id, owner] of owners())
        await tx.write(ownerKey(info.maintenanceID, id), {
          version: 1,
          ownerID: id,
          ownerVersion: owner.version,
          phase: "drained",
          tailRevision: info.tailRevision,
        })
      return info
    })
    const receipt = Object.freeze({ maintenanceID: info.maintenanceID })
    receipts.set(receipt, { ...identity(lease), revision: info.revision, tailRevision: info.tailRevision })
    return receipt
  }
  export async function freeze(lease: Lease, receipt: DrainReceipt) {
    const held = identity(lease)
    const proof = receipts.get(receipt)
    if (
      !proof ||
      proof.runtime !== held.runtime ||
      proof.store !== held.store ||
      proof.maintenanceID !== held.maintenanceID ||
      proof.cohortHash !== held.cohortHash
    )
      throw new Blocked({ message: "Native freeze requires this operation's actual owner drainage receipt" })
    using lock = await Lock.write("runtime-maintenance")
    return mutate(async (tx) => {
      const info = await requireCurrent(tx, lease)
      if (info.tailRevision !== proof.tailRevision || (info.phase !== "frozen" && info.revision !== proof.revision))
        throw new Blocked({ message: "A native writer changed after maintenance drainage" })
      if (info.phase === "frozen") return info
      if (info.phase !== "draining") throw new Blocked({ message: "Maintenance is not ready to freeze" })
      const frozen = Info.parse({ ...info, phase: "frozen", revision: info.revision + 1, updatedAt: Date.now() })
      await tx.write(operationKey(info.maintenanceID), frozen)
      return frozen
    })
  }
  export async function release(lease: Lease, options: { signal?: AbortSignal } = {}) {
    if (identity(lease).resumed) throw new Blocked({ message: "Cold retirement cannot release its original hold" })
    using lock = options.signal
      ? await Lock.writeWithSignal("runtime-maintenance", options.signal)
      : await Lock.write("runtime-maintenance")
    const initial = await Storage.snapshot((tx) => requireCurrent(tx, lease))
    if (await Retirements.read(initial.maintenanceID))
      throw new Blocked({ message: "Source retirement permanently retains its native maintenance hold" })
    if (initial.phase === "released") {
      await reopen(context(lease, options.signal))
      return initial
    }
    if (initial.phase === "recovery-held" || lease.purpose === "organization-restore")
      throw new Blocked({ message: "Restored execution requires independent current-writer reconciliation" })
    const currentContext = context(lease, options.signal)
    await inspectOwners(currentContext)
    await mutate(async (tx) => {
      const info = await requireCurrent(tx, lease)
      await tx.write(
        operationKey(info.maintenanceID),
        Info.parse({ ...info, phase: "releasing", revision: info.revision + 1, updatedAt: Date.now() }),
      )
    })
    for (const [, owner] of owners().reverse()) {
      currentContext.signal.throwIfAborted()
      await owner.release(currentContext)
    }
    await inspectOwners(currentContext)
    const released = await mutate(async (tx) => {
      const info = await requireCurrent(tx, lease)
      if (info.phase !== "releasing") throw new Blocked({ message: "Maintenance release phase changed" })
      const released = Info.parse({ ...info, phase: "released", revision: info.revision + 1, updatedAt: Date.now() })
      await tx.write(operationKey(info.maintenanceID), released)
      return released
    })
    await reopen(currentContext)
    return released
  }
  async function reopen(context: Context) {
    await assertReleased(context.lease)
    for (const [, owner] of owners().reverse()) {
      context.signal.throwIfAborted()
      await owner.released?.(context)
    }
    state().pending = false
  }
}
