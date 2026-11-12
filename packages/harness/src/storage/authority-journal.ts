import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "./storage"
import { StorageMutationGuard } from "./mutation-guard"
import { StorageCheckpoint } from "./checkpoint"
import type { VaultKeyProvider } from "../secrets/encrypted-store"
import { StorageConflictError, StorageIntegrityError } from "./errors"
import type { StoreTransaction, TransactionOptions } from "./transactional-store"

const ID = z.string().min(1).max(128)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Count = z.number().int().nonnegative().safe()
const Key = z.array(z.string().min(1)).min(1)
const root = ["storage_authority_journal"]
const keyHash = (key: readonly string[]) => digest(key)
const headerKey = [...root, "head"]
const fingerprints = (journalID: string) => [...root, "fingerprints", journalID]
const pending = (actionID: string) => [...root, "pending", actionID]
const records = (journalID: string) => [...root, "entries", journalID]
const ordinal = (sequence: number) => String(sequence).padStart(16, "0")
const startsWith = (key: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => key[index] === part)

function digest(value: unknown) {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    )
  })
  return createHash("sha256").update(text).digest("hex")
}

const Header = z.strictObject({
  schemaVersion: z.literal(1),
  journalID: ID,
  namespaceID: ID,
  contractHash: Hash,
  baselineHash: Hash,
  baselineEntries: Count,
  sequence: Count,
  tailHash: Hash,
  startedAt: Count,
  untracked: z.boolean(),
})
type Header = z.infer<typeof Header>
const Fingerprint = z.strictObject({ domainID: ID, key: Key, hash: Hash })
const Baseline = z.strictObject({ sequence: Count.positive(), fingerprint: Fingerprint })
const Pending = z.strictObject({ domainID: ID, key: Key, beforeHash: Hash.optional(), before: JsonValue.optional() })
const Entry = z.strictObject({
  schemaVersion: z.literal(1),
  journalID: ID,
  sequence: Count.positive(),
  previousHash: Hash,
  actionID: ID,
  operation: ID,
  actor: ActorStamp.Info,
  domainID: ID,
  key: Key,
  beforeHash: Hash.optional(),
  afterHash: Hash.optional(),
  before: JsonValue.optional(),
  after: JsonValue.optional(),
  changedAt: Count,
  hash: Hash,
})
type Entry = z.infer<typeof Entry>
interface Domain {
  id: string
  version: number
  prefixes: readonly (readonly string[])[]
  project(key: readonly string[], value: unknown): z.infer<typeof JsonValue> | undefined
}
const registry = RuntimeContext.state(() => ({ domains: new Map<string, Domain>(), installed: false }))
interface Action {
  runtime: RuntimeContext.Instance
  store: Storage.Handle["store"]
  actionID: string
  operation: string
  actor?: ActorStamp.Info
}
const actions = new AsyncLocalStorage<Action>()

async function read<T>(tx: StoreTransaction, schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
  const [value] = await tx.readMany([key])
  return value === undefined ? undefined : schema.parse(value)
}

async function* rows(tx: StoreTransaction, prefix: string[]) {
  let after: string[] | undefined
  for (;;) {
    const page = await tx.query({ prefix, after, limit: 128 })
    if (!page.length) return
    yield* page
    after = page.at(-1)?.key
    if (page.length < 128) return
  }
}

function domains() {
  return [...registry().domains.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
function contractHash() {
  return digest(
    domains().map((domain) => ({
      id: domain.id,
      version: domain.version,
      prefixes: domain.prefixes
        .map((prefix) => [...prefix])
        .sort((left, right) =>
          JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0,
        ),
    })),
  )
}
function domainFor(key: string[]) {
  return domains().find((domain) => domain.prefixes.some((prefix) => startsWith(key, prefix)))
}

async function unknown(tx: StoreTransaction) {
  const head = await read(tx, Header, headerKey)
  if (head && !head.untracked) await tx.write(headerKey, { ...head, untracked: true })
}

function project(domain: Domain, key: readonly string[], value: unknown) {
  const projected = domain.project(key, value)
  return projected === undefined ? undefined : JsonValue.parse(projected)
}

async function inspectUntracked(tx: StoreTransaction, key: string[], domain: Domain) {
  const head = await read(tx, Header, headerKey)
  if (!head) return
  const expected = await read(tx, Fingerprint, [...fingerprints(head.journalID), keyHash(key)])
  const [value] = await tx.readMany([key])
  const before = value === undefined ? undefined : project(domain, key, value)
  if (expected?.hash !== (before === undefined ? undefined : digest(before))) await unknown(tx)
}

async function track(tx: StoreTransaction, key: string[], domain: Domain, action: Action) {
  if (!action.actor)
    throw new StorageConflictError("An authority writer must identify its validated actor before mutation")
  const destination = [...pending(action.actionID), keyHash(key)]
  if (await read(tx, Pending, destination)) return
  const [value] = await tx.readMany([key])
  const before = value === undefined ? undefined : project(domain, key, value)
  await tx.write(
    destination,
    Pending.parse({ domainID: domain.id, key, before, beforeHash: before === undefined ? undefined : digest(before) }),
  )
}

async function observe(tx: StoreTransaction, keys: readonly string[][], tree: boolean) {
  const action = actions.getStore()
  if (action && (action.runtime !== RuntimeContext.current() || action.store !== Storage.current().store))
    throw new StorageConflictError("An authority action cannot cross Runtime or namespace ownership")
  for (const key of keys) {
    if (!tree) {
      const domain = domainFor(key)
      if (!domain) continue
      if (!action) {
        await inspectUntracked(tx, key, domain)
        continue
      }
      await track(tx, key, domain, action)
      continue
    }
    for (const domain of domains())
      for (const prefix of domain.prefixes) {
        const intersection = startsWith(key, prefix) ? key : startsWith(prefix, key) ? [...prefix] : undefined
        if (!intersection) continue
        for await (const row of rows(tx, intersection)) {
          if (!action) {
            await inspectUntracked(tx, row.key, domain)
            continue
          }
          await track(tx, row.key, domain, action)
        }
      }
  }
}

async function finish(tx: StoreTransaction, action: Action) {
  let head = await read(tx, Header, headerKey)
  if (!head) throw new StorageConflictError("The authority journal requires its owning initialization migration")
  if (head.contractHash !== contractHash())
    throw new StorageConflictError("The authority journal contract requires an owning migration")
  for await (const row of rows(tx, pending(action.actionID))) {
    const change = Pending.parse(row.value)
    const domain = registry().domains.get(change.domainID)
    if (!domain || !action.actor)
      throw new StorageIntegrityError("An authority writer lost its registered owner or actor")
    const key = [...fingerprints(head.journalID), keyHash(change.key)]
    const before = await read(tx, Fingerprint, key)
    if (before?.hash !== change.beforeHash) head = { ...head, untracked: true }
    const [value] = await tx.readMany([change.key])
    const after = value === undefined ? undefined : project(domain, change.key, value)
    const afterHash = after === undefined ? undefined : digest(after)
    if (change.beforeHash !== afterHash) {
      const body = {
        schemaVersion: 1 as const,
        journalID: head.journalID,
        sequence: head.sequence + 1,
        previousHash: head.tailHash,
        actionID: action.actionID,
        operation: action.operation,
        actor: action.actor,
        domainID: change.domainID,
        key: change.key,
        beforeHash: change.beforeHash,
        before: change.before,
        afterHash,
        after,
        changedAt: Date.now(),
      }
      const entry = Entry.parse({ ...body, hash: digest(body) })
      await tx.write([...records(head.journalID), ordinal(entry.sequence)], entry)
      head = { ...head, sequence: entry.sequence, tailHash: entry.hash }
    }
    if (afterHash === undefined) await tx.remove(key)
    else await tx.write(key, Fingerprint.parse({ domainID: change.domainID, key: change.key, hash: afterHash }))
    await tx.remove(row.key)
  }
  await tx.write(headerKey, head)
}

export namespace AuthorityJournal {
  export const Checkpoint = Header
  export type Checkpoint = z.infer<typeof Checkpoint>
  export async function readArchivedCheckpoint(input: {
    directory: string
    expected: StorageCheckpoint.Manifest
    keys: VaultKeyProvider
    signal?: AbortSignal
  }): Promise<Checkpoint> {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    let checkpoint: Checkpoint | undefined
    for await (const entry of StorageCheckpoint.entries({ directory, expected, keys, signal })) {
      if (entry.type !== "record" || JSON.stringify(entry.key) !== JSON.stringify(headerKey)) continue
      if (checkpoint) throw new StorageIntegrityError("A checkpoint contains repeated authority history")
      checkpoint = Checkpoint.parse(entry.value)
    }
    signal?.throwIfAborted()
    if (!checkpoint) throw new StorageIntegrityError("A checkpoint has no authority history")
    return Checkpoint.parse(checkpoint)
  }
  export type Contribution = Domain
  export function selected() {
    return registry().installed
  }
  export function definition() {
    return {
      hash: contractHash(),
      domains: domains().map(({ id, version, prefixes }) => ({
        id,
        version,
        prefixes: prefixes.map((prefix) => [...prefix]),
      })),
    }
  }
  export function register(domain: Domain) {
    RuntimeContext.assertCompositionOpen("authority journal domains")
    ID.parse(domain.id)
    z.number().int().positive().parse(domain.version)
    const state = registry()
    if (state.domains.has(domain.id) || !domain.prefixes.length)
      throw new Error("An authority journal domain must be unique and declare its canonical prefixes")
    for (const [index, prefix] of domain.prefixes.entries()) {
      Key.parse(prefix)
      for (const other of domain.prefixes.slice(0, index))
        if (startsWith(prefix, other) || startsWith(other, prefix))
          throw new Error("Authority journal canonical prefixes cannot overlap")
      if (startsWith(prefix, root) || startsWith(root, prefix))
        throw new Error("Authority projections cannot own the journal itself")
      for (const existing of state.domains.values())
        for (const other of existing.prefixes)
          if (startsWith(prefix, other) || startsWith(other, prefix))
            throw new Error("Authority journal domains cannot overlap")
    }
    state.domains.set(domain.id, { ...domain, prefixes: domain.prefixes.map((prefix) => [...prefix]) })
    if (!state.installed) {
      StorageMutationGuard.register("authority-journal", observe)
      state.installed = true
    }
  }

  export async function initialize(input: { namespaceID: string }) {
    ID.parse(input.namespaceID)
    if (!registry().domains.size) throw new StorageConflictError("An authority journal must select its owning domains")
    const journalID = randomUUID()
    return Storage.transaction(async (tx) => {
      const existing = await read(tx, Header, headerKey)
      const contract = contractHash()
      if (existing) {
        if (existing.namespaceID !== input.namespaceID || existing.contractHash !== contract)
          throw new StorageConflictError("Existing authority history requires an explicit owning migration")
        return existing
      }
      const hash = createHash("sha256").update(
        JSON.stringify(["synergy-authority-baseline-v1", journalID, input.namespaceID, contract]),
      )
      let baselineEntries = 0
      for (const domain of domains())
        for (const prefix of domain.prefixes)
          for await (const row of rows(tx, [...prefix])) {
            const projected = project(domain, row.key, row.value)
            if (projected === undefined) continue
            const fingerprint = Fingerprint.parse({ domainID: domain.id, key: row.key, hash: digest(projected) })
            hash.update(JSON.stringify(fingerprint))
            await tx.write([...fingerprints(journalID), keyHash(row.key)], fingerprint)
            await tx.write(
              [...root, "baseline", journalID, ordinal(++baselineEntries)],
              Baseline.parse({ sequence: baselineEntries, fingerprint }),
            )
          }
      const baselineHash = hash.digest("hex")
      const head = Header.parse({
        schemaVersion: 1,
        journalID,
        namespaceID: input.namespaceID,
        contractHash: contract,
        baselineHash,
        baselineEntries,
        sequence: 0,
        tailHash: baselineHash,
        startedAt: Date.now(),
        untracked: false,
      })
      await tx.write(headerKey, head)
      return head
    })
  }

  export async function transaction<T>(
    operation: string,
    body: (journal: { identify(actor: ActorStamp.Info): void; actionID: string }) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    ID.parse(operation)
    if (!registry().installed) {
      const actionID = randomUUID()
      return Storage.transaction(
        () =>
          body({
            identify: (actor) => {
              ActorStamp.Info.parse(actor)
            },
            actionID,
          }),
        options,
      )
    }
    const parent = actions.getStore()
    const action: Action = parent ?? {
      runtime: RuntimeContext.current(),
      store: Storage.current().store,
      actionID: randomUUID(),
      operation,
    }
    const identify = (value: ActorStamp.Info) => {
      const actor = ActorStamp.Info.parse(value)
      if (action.actor && digest(action.actor) !== digest(actor))
        throw new StorageConflictError("One authority transaction cannot change its validated actor")
      action.actor = actor
    }
    return actions.run(action, () =>
      Storage.transaction(async (tx) => {
        if (!parent) action.actor = undefined
        const result = await body({ identify, actionID: action.actionID })
        if (!parent) await finish(tx, action)
        return result
      }, options),
    )
  }

  export async function head(): Promise<Header> {
    return Storage.snapshot(async (tx) => {
      const head = await read(tx, Header, headerKey)
      if (!head) throw new StorageConflictError("The authority journal is not initialized")
      return head
    })
  }

  export async function entries(input: { after?: number; limit?: number }) {
    const query = z
      .strictObject({ after: Count.default(0), limit: z.number().int().min(1).max(128).default(50) })
      .parse(input)
    return Storage.snapshot(async (tx) => {
      const head = await read(tx, Header, headerKey)
      if (!head) throw new StorageConflictError("The authority journal is not initialized")
      const prefix = records(head.journalID)
      const page = await tx.query({ prefix, after: [...prefix, ordinal(query.after)], limit: query.limit + 1 })
      const items = page.slice(0, query.limit).map((row) => Entry.parse(row.value))
      return { head, items, cursor: page.length > query.limit ? items.at(-1)?.sequence : undefined }
    })
  }

  export async function inspect() {
    return Storage.snapshot(async (tx) => {
      const head = await read(tx, Header, headerKey)
      if (!head) return { covered: false, initialized: false, fingerprintGaps: 0, chainValid: false }
      let fingerprintGaps = 0
      for await (const row of rows(tx, fingerprints(head.journalID))) {
        const expected = Fingerprint.parse(row.value)
        const domain = registry().domains.get(expected.domainID)
        const [value] = await tx.readMany([expected.key])
        const current = value === undefined || !domain ? undefined : project(domain, expected.key, value)
        if (current === undefined || digest(current) !== expected.hash || row.key.at(-1) !== keyHash(expected.key))
          fingerprintGaps++
      }
      for (const domain of domains())
        for (const prefix of domain.prefixes)
          for await (const row of rows(tx, [...prefix])) {
            const current = project(domain, row.key, row.value)
            if (current === undefined) continue
            const expected = await read(tx, Fingerprint, [...fingerprints(head.journalID), keyHash(row.key)])
            if (!expected) fingerprintGaps++
          }
      const baseline = createHash("sha256").update(
        JSON.stringify(["synergy-authority-baseline-v1", head.journalID, head.namespaceID, head.contractHash]),
      )
      let count = 0
      let chainValid = true
      for await (const row of rows(tx, [...root, "baseline", head.journalID])) {
        const entry = Baseline.parse(row.value)
        if (entry.sequence !== ++count || row.key.at(-1) !== ordinal(count)) chainValid = false
        baseline.update(JSON.stringify(entry.fingerprint))
      }
      chainValid = chainValid && count === head.baselineEntries && baseline.digest("hex") === head.baselineHash
      let previous = head.baselineHash
      let sequence = 0
      for await (const row of rows(tx, records(head.journalID))) {
        const entry = Entry.parse(row.value)
        const { hash, ...body } = entry
        if (
          entry.sequence !== ++sequence ||
          entry.previousHash !== previous ||
          digest(body) !== hash ||
          row.key.at(-1) !== ordinal(sequence)
        )
          chainValid = false
        previous = hash
      }
      chainValid = chainValid && sequence === head.sequence && previous === head.tailHash
      return {
        head,
        initialized: true,
        fingerprintGaps,
        chainValid,
        covered: head.contractHash === contractHash() && !head.untracked && fingerprintGaps === 0 && chainValid,
      }
    })
  }
}
