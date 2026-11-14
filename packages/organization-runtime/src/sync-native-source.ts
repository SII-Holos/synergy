import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import { StorageEventSinks } from "@ericsanchezok/synergy-harness/storage/event-sinks"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionPartCommit } from "@ericsanchezok/synergy-harness/session/part-commit"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationSyncPath as Keys } from "./storage/path"
import {
  binding,
  mutationBinding,
  putDrafts,
  draftID as identityDraftID,
  type Bound,
  type DraftInput,
  type WriteOwner,
} from "./sync-outbox"
import { createSyncProjection } from "./sync-projection"

const sinkID = "organization-native-sync"
const NativeID = z.string()
const Selector = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session") }),
  z.strictObject({ kind: z.literal("message"), messageID: NativeID }),
  z.strictObject({
    kind: z.literal("part"),
    messageID: NativeID,
    partID: NativeID,
    revision: z.string().regex(/^\d+$/),
    removed: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("rollout"), revision: z.number().int().positive().safe() }),
  z.strictObject({
    kind: z.literal("notification"),
    itemID: NativeID,
    messageID: NativeID,
    taskID: NativeID,
    createdAt: z.number(),
    summary: z.string().max(32 * 1024),
  }),
])
const Capture = z.strictObject({
  version: z.literal(1),
  rootSessionID: NativeID,
  sessionID: NativeID,
  scopeID: NativeID,
  binding: Protocol.SessionBinding,
  selector: Selector,
})
type Capture = z.infer<typeof Capture>
export interface NativeSyncFault {
  rootSessionID: string
  binding: Protocol.SessionBinding
  reason: "storage_full"
  revision: number
}
const sources = RuntimeContext.state(() => ({
  faults: new Map<string, NativeSyncFault>(),
  wake: new Set<(rootSessionID: string) => void>(),
  failures: new WeakMap<object, Set<string>>(),
}))
const preparation = RuntimeContext.createAsyncContext<{
  runtime: RuntimeContext.Instance
  store: ReturnType<typeof Storage.current>["store"]
  binding: Epochs.Binding
  active: boolean
}>()
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
function partition(value: Pick<Capture, "rootSessionID" | "binding">) {
  return digest([value.binding.orgID, value.rootSessionID, value.binding.bindingEpoch])
}
function same(first: unknown, second: unknown) {
  return JSON.stringify(first) === JSON.stringify(second)
}
function properties(event: Parameters<StorageEventSinks.Sink["capture"]>[0]) {
  return z.object({ properties: z.unknown() }).parse(event.payload).properties
}
function full(error: unknown) {
  const seen = new Set<object>()
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error)
    if ("code" in error && (error.code === "SQLITE_FULL" || error.code === "ENOSPC")) return true
    error = "cause" in error ? error.cause : undefined
  }
  return false
}
export function observeNativeSyncFailure(captured: Pick<Capture, "rootSessionID" | "binding">, error: unknown) {
  if (!full(error)) return
  sources().faults.set(captured.rootSessionID, {
    rootSessionID: captured.rootSessionID,
    binding: captured.binding,
    reason: "storage_full",
    revision: (sources().faults.get(captured.rootSessionID)?.revision ?? 0) + 1,
  })
}
export function nativeSyncFaults() {
  return [...sources().faults.values()].map((value) => structuredClone(value))
}
export function clearNativeSyncFault(value: NativeSyncFault) {
  if (!same(sources().faults.get(value.rootSessionID), value)) return false
  sources().faults.delete(value.rootSessionID)
  return true
}
export function observeNativeSync(wake: (rootSessionID: string) => void) {
  sources().wake.add(wake)
  return () => {
    sources().wake.delete(wake)
  }
}
function observeFailure(captured: Pick<Capture, "rootSessionID" | "binding">) {
  const transaction = Storage.current().transaction
  if (!transaction) throw new Error("Native shared failure observation requires its original writer")
  const state = sources()
  let roots = state.failures.get(transaction)
  if (!roots) {
    roots = new Set<string>()
    state.failures.set(transaction, roots)
  }
  const key = JSON.stringify([captured.rootSessionID, captured.binding])
  if (roots.has(key)) return
  roots.add(key)
  Storage.afterFailure((error) => {
    observeNativeSyncFailure(captured, error)
  })
}
function assertOwner(runtime: RuntimeContext.Instance, store: ReturnType<typeof Storage.current>["store"]) {
  if (RuntimeContext.current() !== runtime || Storage.current().store !== store)
    throw new Error("Native shared delivery lost its original Runtime or Store")
}
async function current(captured: Capture) {
  const value = await binding(captured.sessionID, captured.binding.orgID, captured.scopeID)
  if (
    !value ||
    value.rootSessionID !== captured.rootSessionID ||
    value.session.scope.id !== captured.scopeID ||
    !same(value.binding, captured.binding)
  )
    throw new Error("Native shared delivery changed its original Session binding")
  const active = preparation.getStore()
  if (active) {
    assertOwner(active.runtime, active.store)
    if (
      !active.active ||
      active.binding.sessionID !== captured.rootSessionID ||
      active.binding.scopeID !== captured.scopeID ||
      active.binding.fromEpoch !== captured.binding.bindingEpoch ||
      active.binding.sourceID !== captured.binding.driverRuntimeID
    )
      throw new Error("Native shared delivery lacks its exact source preparation frame")
    const actual = await Epochs.ownerPreparationBinding({
      sessionID: captured.sessionID,
      handoffID: active.binding.handoffID,
    })
    const expected = Epochs.Binding.parse({
      ...active.binding,
      sessionID: captured.sessionID,
      ...(captured.sessionID === active.binding.sessionID ? {} : { rootSessionID: active.binding.sessionID }),
    })
    if (!same(actual, expected)) throw new Error("Native shared delivery changed its original source preparation")
  } else if (await Epochs.isFrozen(captured.rootSessionID)) {
    throw new Error("Native shared delivery requires its original source preparation while frozen")
  }
  return value
}
function owner(captured: Capture): WriteOwner {
  const runtime = RuntimeContext.current()
  const store = Storage.current().store
  const active = preparation.getStore()
  return {
    async check() {
      assertOwner(runtime, store)
      await current(captured)
    },
    afterFailure(error) {
      observeNativeSyncFailure(captured, error)
    },
    assertCurrent() {
      assertOwner(runtime, store)
      if (active && (!active.active || preparation.getStore() !== active))
        throw new Error("Native shared delivery source preparation has ended")
    },
  }
}
async function localWrite(bound: Bound, key: string[], value: unknown, authority: WriteOwner) {
  await authority.check()
  await Storage.transaction(
    async () => {
      observeFailure(bound)
      await authority.check()
      await Storage.write(key, value)
    },
    { commitGuard: authority.assertCurrent },
  )
}
async function superseded(delivery: Readonly<StorageEventSinks.Delivery>, captured: Capture) {
  if (captured.selector.kind !== "part") return false
  for await (const row of Storage.records<StorageEventSinks.Delivery>({
    prefix: ["event_delivery", sinkID, delivery.partition],
    limit: 128,
  })) {
    if (
      row.value.sinkID !== sinkID ||
      row.value.partition !== delivery.partition ||
      !Number.isSafeInteger(row.value.sequence) ||
      row.value.sequence < 1 ||
      !same(row.key, ["event_delivery", sinkID, delivery.partition, String(row.value.sequence).padStart(16, "0")])
    )
      throw new Error("Retained native removal delivery changed its original queue identity")
    if (row.value.sequence <= delivery.sequence) continue
    const next = Capture.parse(row.value.payload)
    if (
      next.sessionID === captured.sessionID &&
      next.rootSessionID === captured.rootSessionID &&
      same(next.binding, captured.binding) &&
      next.selector.kind === "part" &&
      next.selector.removed &&
      next.selector.messageID === captured.selector.messageID &&
      next.selector.partID === captured.selector.partID &&
      BigInt(next.selector.revision) >= BigInt(captured.selector.revision)
    )
      return true
  }
  return false
}
async function deliver(deliveries: readonly Readonly<StorageEventSinks.Delivery>[]) {
  if (!deliveries.length) return
  const runtime = RuntimeContext.current()
  const store = Storage.current().store
  const captures = deliveries.map((delivery) => {
    const captured = Capture.parse(delivery.payload)
    if (delivery.sinkID !== sinkID || delivery.partition !== partition(captured))
      throw new Error("Native shared delivery changed its original partition")
    return captured
  })
  const first = captures[0]!
  const authority = owner(first)
  const collected = new Map<string, DraftInput>()
  let original: Bound | undefined
  const projection = createSyncProjection({
    orgID: first.binding.orgID,
    async binding(sessionID) {
      const capture = { ...first, sessionID }
      const selected = await current(capture)
      assertOwner(runtime, store)
      return selected
    },
    async putDrafts(rootSessionID, values, bound) {
      if (rootSessionID !== first.rootSessionID) throw new Error("Native shared projection changed its root")
      original ??= bound
      for (const value of values) collected.set(value.draftID, value)
    },
    write: (bound, key, value) => localWrite(bound, key, value, authority),
  })
  const changes = new Map<string, { captured: Capture; delivery: Readonly<StorageEventSinks.Delivery> }>()
  for (let index = 0; index < captures.length; index++) {
    const captured = captures[index]!
    if (captured.rootSessionID !== first.rootSessionID || !same(captured.binding, first.binding))
      throw new Error("Native shared delivery window crossed its original root")
    await current(captured)
    const selector = captured.selector
    const key =
      selector.kind === "part"
        ? [captured.sessionID, "part", selector.messageID, selector.partID]
        : selector.kind === "message"
          ? [captured.sessionID, "message", selector.messageID]
          : selector.kind === "notification"
            ? [captured.sessionID, "notification", selector.itemID]
            : selector.kind === "rollout"
              ? [captured.sessionID, "rollout", selector.revision]
              : [captured.sessionID, "session"]
    changes.set(JSON.stringify(key), { captured, delivery: deliveries[index]! })
  }
  try {
    const sessions = new Set<string>()
    for (const { captured, delivery } of changes.values()) {
      const bound = await current(captured)
      original ??= bound
      const selector = captured.selector
      if (!sessions.has(captured.sessionID)) {
        await projection.projectSession(captured.sessionID)
        sessions.add(captured.sessionID)
      }
      if (selector.kind === "message") {
        const info = await MessageV2.readInfo({
          scopeID: captured.scopeID,
          sessionID: captured.sessionID,
          messageID: selector.messageID,
        })
        if (info.id !== selector.messageID || info.sessionID !== captured.sessionID)
          throw new Error("Shared message changed its original native identity")
        await projection.projectMessage(info)
      } else if (selector.kind === "part") {
        const part = selector.removed
          ? undefined
          : await MessageV2.readPart({
              scopeID: captured.scopeID,
              sessionID: captured.sessionID,
              messageID: selector.messageID,
              partID: selector.partID,
            })
        if (selector.removed) {
          const removed = {
            type: "part",
            sequence: 1,
            sessionID: captured.sessionID,
            messageID: selector.messageID,
            partID: selector.partID,
            removed: true,
          }
          const draftID = identityDraftID({ type: "part", sessionID: captured.sessionID, partID: selector.partID })
          collected.set(draftID, { draftID, event: Sync.Event.parse({ ...removed, integrity: digest(removed) }) })
        } else if (!part) {
          if (!(await superseded(delivery, captured)))
            throw new Error("Native Part disappeared without its original committed removal")
        } else {
          if (
            part.sessionID !== captured.sessionID ||
            part.messageID !== selector.messageID ||
            part.id !== selector.partID
          )
            throw new Error("Shared Part changed its original native identity")
          await projection.projectPart(part)
          if (part.type === "attachment") await projection.projectAttachment(part)
          if (part.type === "tool" && part.state.status === "completed")
            for (const attachment of part.state.attachments ?? []) await projection.projectAttachment(attachment)
        }
      } else if (selector.kind === "rollout") {
        const record = await RolloutEvents.readCommitted(
          { kind: "session", scopeID: captured.scopeID, sessionID: captured.sessionID },
          selector.revision,
        )
        await projection.projectTool({ sessionID: captured.sessionID, record })
      } else if (selector.kind === "notification") {
        await projection.projectNotification({
          sessionID: captured.sessionID,
          notificationID: selector.itemID,
          taskID: selector.taskID,
          createdAt: selector.createdAt,
          summary: selector.summary,
        })
      }
    }
    if (!original) throw new Error("Native shared delivery lacks its original bound root")
    let window: DraftInput[] = []
    let bytes = 0
    async function publish() {
      if (!window.length || !original) return
      await putDrafts(original, window, authority)
      window = []
      bytes = 0
    }
    for (const value of collected.values()) {
      const weight = Buffer.byteLength(JSON.stringify(value.event))
      if (window.length && (window.length >= 128 || bytes + weight > 1024 * 1024)) await publish()
      window.push(value)
      bytes += weight
    }
    await publish()
    for (const captured of captures) await current(captured)
    authority.assertCurrent()
  } catch (error) {
    observeNativeSyncFailure(first, error)
    throw error
  }
}
async function retainedNativeRoot(rootSessionID: string, orgID: string) {
  if ((await Storage.query({ prefix: Keys.drafts(orgID, rootSessionID), limit: 1 })).length) return true
  if ((await Storage.readMany([Keys.batch(orgID, rootSessionID)]))[0] !== undefined) return true
  for await (const row of Storage.records<StorageEventSinks.Delivery>({
    prefix: ["event_delivery", sinkID],
    limit: 128,
  })) {
    const captured = Capture.parse(row.value.payload)
    if (captured.binding.orgID !== orgID) throw new Error("Native shared dependency belongs to another organization")
    if (captured.rootSessionID === rootSessionID) return true
  }
  return false
}

export function registerNativeSyncSource(orgID: string) {
  StorageMutationGuard.register("organization-sync-dependencies", async (_tx, keys, tree) => {
    for (const key of keys) {
      const native = key[0] === "sessions" && key.length >= 3
      const shared =
        key[0] === "organization-sync" &&
        key[1] === orgID &&
        key.length >= 4 &&
        (key[2] === "sessions" || key[2] === "roots")
      const sessionID = native ? key[2] : shared ? key[3] : undefined
      if (!sessionID) continue
      const original = await mutationBinding(sessionID, orgID, native ? key[1] : undefined)
      if (!original) continue
      if (native && original.session.scope.id !== key[1])
        throw new Error("Native shared mutation changed its actual Scope")
      observeFailure(original)
    }
    if (!tree) return
    for (const key of keys) {
      if (key[0] !== "sessions" || (key.length > 3 && key[3] !== "rollout")) continue
      if (key[3] === "rollout" && (key[4] === "tool_parts" || key[4] === "tool_part_schema")) continue
      if (key.length >= 3) {
        const bound = await binding(key[2]!, orgID, key[1])
        if (!bound) continue
        if (bound.session.scope.id !== key[1]) throw new Error("Native shared deletion changed its actual Scope")
        if (await retainedNativeRoot(bound.rootSessionID, orgID))
          throw new Error("Native shared dependencies require their original outbox acknowledgement")
        continue
      }
      for await (const row of Storage.records<{ sessionID: string }>({ prefix: Keys.roots(orgID), limit: 128 })) {
        const root = z.strictObject({ sessionID: NativeID }).parse(row.value)
        const actual = await binding(root.sessionID, orgID)
        if (key[1] && actual && actual.session.scope.id !== key[1]) continue
        if (await retainedNativeRoot(root.sessionID, orgID))
          throw new Error("Native shared dependencies require their original outbox acknowledgement")
      }
    }
  })
  StorageEventSinks.register({
    id: sinkID,
    async capture(event) {
      let sessionID: string
      let selector: z.infer<typeof Selector>
      if (event.type === SessionEvent.Updated.type) {
        const value = SessionEvent.Updated.properties.parse(properties(event))
        sessionID = value.info.id
        selector = { kind: "session" }
      } else if (event.type === MessageV2.Event.Updated.type) {
        const value = MessageV2.Event.Updated.properties.parse(properties(event))
        sessionID = value.info.sessionID
        selector = { kind: "message", messageID: value.info.id }
      } else if (event.type === SessionPartCommit.RecordCommitted.type) {
        const value = SessionPartCommit.RecordCommitted.properties.parse(properties(event))
        if (value.scopeID !== event.scopeID) throw new Error("Native Part fact changed its Scope")
        sessionID = value.sessionID
        selector = {
          kind: "part",
          messageID: value.messageID,
          partID: value.partID,
          revision: value.revision,
          removed: value.removed,
        }
      } else if (event.type === RolloutEvents.RecordCommitted.type) {
        const value = RolloutEvents.RecordCommitted.properties.parse(properties(event))
        if (value.owner.kind !== "session") return
        if (value.owner.scopeID !== event.scopeID) throw new Error("Native Rollout fact changed its Scope")
        sessionID = value.owner.sessionID
        selector = { kind: "rollout", revision: value.revision }
      } else if (event.type === SessionInbox.RecordCommitted.type) {
        const value = SessionInbox.RecordCommitted.properties.parse(properties(event))
        if (value.scopeID !== event.scopeID) throw new Error("Native Inbox fact changed its Scope")
        const item = await SessionInbox.getStored(value.sessionID, value.itemID)
        if (item.sessionID !== value.sessionID || item.id !== value.itemID)
          throw new Error("Native Inbox fact changed its original item")
        const prefix = "cortex:taskNotification:"
        if (!item.deliveryKey?.startsWith(prefix)) return
        const taskID = item.deliveryKey.slice(prefix.length)
        if (!taskID) return
        sessionID = value.sessionID
        selector = {
          kind: "notification",
          itemID: item.id,
          messageID: item.messageID,
          taskID,
          createdAt: item.time.created,
          summary: (item.summary.preview ?? item.summary.title).slice(0, 32 * 1024),
        }
      } else return
      const bound = await binding(sessionID, orgID, event.scopeID)
      if (!bound) return
      if (bound.session.scope.id !== event.scopeID) throw new Error("Native shared fact changed its actual Scope")
      const captured = Capture.parse({
        version: 1,
        rootSessionID: bound.rootSessionID,
        sessionID,
        scopeID: event.scopeID,
        binding: bound.binding,
        selector,
      })
      observeFailure(captured)
      const key = Keys.registeredRoot(orgID, captured.rootSessionID)
      const [root] = await Storage.readMany([key])
      if (root === undefined) await Storage.write(key, { sessionID: captured.rootSessionID })
      else if (z.strictObject({ sessionID: NativeID }).parse(root).sessionID !== captured.rootSessionID)
        throw new Error("Native shared root index changed its original identity")
      Storage.afterCommit(() => {
        for (const wake of sources().wake) wake(captured.rootSessionID)
      })
      return { partition: partition(captured), payload: captured }
    },
    deliver: (delivery) => deliver([delivery]),
    deliverBatch: deliver,
  })
}
export async function pumpNativeSync(original: Pick<Capture, "rootSessionID" | "binding">) {
  let delivered: number
  do {
    ;({ delivered } = await StorageEventSinks.flush({ limit: 128, sinkID, partition: partition(original) }))
  } while (delivered)
  if (preparation.getStore()) {
    for await (const row of Storage.records<StorageEventSinks.Delivery>({
      prefix: ["event_delivery", sinkID],
      limit: 128,
    })) {
      const captured = Capture.parse(row.value.payload)
      if (captured.rootSessionID === original.rootSessionID)
        throw new Error("Source preparation retains a delivery outside its original binding partition")
    }
  }
}
export async function prepareNativeSync<T>(value: Epochs.Binding, body: () => Promise<T>) {
  if (Storage.inTransaction()) throw new Error("Native shared source preparation must begin outside SQL")
  const actual = await Epochs.ownerPreparationBinding({ sessionID: value.sessionID, handoffID: value.handoffID })
  if (!same(actual, value)) throw new Error("Native shared source preparation changed its original binding")
  const active = { runtime: RuntimeContext.current(), store: Storage.current().store, binding: actual, active: true }
  try {
    return await preparation.run(active, body)
  } finally {
    active.active = false
  }
}
