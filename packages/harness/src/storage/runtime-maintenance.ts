import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { Lock } from "../util/lock"
import { Storage } from "./storage"
import { StorageMutationGuard } from "./mutation-guard"
import type { StoreTransaction, TransactionOptions } from "./transactional-store"

const ID = z.string().min(1).max(128)
const Count = z.number().int().nonnegative().safe()
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const root = ["runtime_maintenance"]
const currentKey = [...root, "current"]
const operationKey = (id: string) => [...root, "operations", id]
const requestKey = (id: string) => [...root, "requests", id]
const ownerKey = (id: string, owner: string) => [...root, "owners", id, owner]
const startsWith = (key: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => key[index] === part)
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Operator = ActorStamp.Info.refine(
  (actor) => actor.kind !== "account",
  "Maintenance requires trusted Host authority",
)
const mutation = RuntimeContext.createAsyncContext<{
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
}>()
function mutate<T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) {
  return mutation.run({ runtime: RuntimeContext.current(), store: Storage.current().store }, () =>
    Storage.transaction(body, options),
  )
}

export namespace RuntimeMaintenance {
  export const Purpose = z.enum(["organization-backup", "organization-restore"])
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
  export const Info = z.strictObject({
    version: z.literal(1),
    maintenanceID: ID,
    requestID: ID,
    requestHash: Hash,
    purpose: Purpose,
    sourceRuntimeID: ID,
    cohortHash: Hash,
    phase: z.enum(["draining", "frozen", "releasing", "released", "recovery-held"]),
    revision: Count.positive(),
    tailRevision: Count,
    actor: Operator,
    createdAt: Count,
    updatedAt: Count,
  })
  export type Info = z.infer<typeof Info>
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
  }
  interface LeaseIdentity {
    runtime: RuntimeContext.Instance
    store: Storage.Handle["store"]
    maintenanceID: string
    cohortHash: string
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
  }))

  async function read<T>(tx: StoreTransaction, schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
    const [value] = await tx.readMany([key])
    return value === undefined ? undefined : schema.parse(value)
  }
  async function current(tx: StoreTransaction) {
    const pointer = await read(tx, z.strictObject({ maintenanceID: ID }), currentKey)
    if (!pointer) {
      if ((await tx.queryKeys({ prefix: [...root, "operations"], limit: 1 })).length)
        throw new Blocked({ message: "Maintenance history has no current operation pointer" })
      return
    }
    const info = await read(tx, Info, operationKey(pointer.maintenanceID))
    if (!info || info.maintenanceID !== pointer.maintenanceID)
      throw new Blocked({ message: "Maintenance operation is missing or inconsistent" })
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
    return value
  }
  async function requireCurrent(tx: StoreTransaction, lease: Lease) {
    const held = identity(lease)
    const info = await current(tx)
    if (
      !info ||
      info.maintenanceID !== held.maintenanceID ||
      info.sourceRuntimeID !== held.runtime.id ||
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
  export async function assertMutation() {
    const info = await status()
    if (info && !["released", "draining", "releasing"].includes(info.phase))
      throw new Blocked({
        maintenanceID: info.maintenanceID,
        message: "Maintenance freezes ordinary canonical mutations",
      })
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
    const result = await body(currentContext)
    currentContext.signal.throwIfAborted()
    await assertFrozen()
    return result
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
    identity(lease)
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
    identity(lease)
    using lock = options.signal
      ? await Lock.writeWithSignal("runtime-maintenance", options.signal)
      : await Lock.write("runtime-maintenance")
    const initial = await Storage.snapshot((tx) => requireCurrent(tx, lease))
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
