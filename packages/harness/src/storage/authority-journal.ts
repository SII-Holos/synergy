import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "./storage"
import { StorageMutationGuard } from "./mutation-guard"
import { StorageCheckpoint } from "./checkpoint"
import type { VaultKeyProvider } from "../secrets/encrypted-store"
import { StorageConflictError, StorageIntegrityError } from "./errors"
import { initializeSqliteEngine } from "./sqlite-engine"
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
type ChainRow = { key: readonly string[]; value: unknown }
type Projection = { baseline(value: z.infer<typeof Fingerprint>): void; change(value: Entry): void }

async function historyIndex() {
  initializeSqliteEngine()
  const directory = await fs.mkdtemp(path.join(tmpdir(), "synergy-authority-"))
  let database: Database | undefined
  try {
    database = new Database(path.join(directory, "journal.sqlite"))
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE history(kind TEXT NOT NULL,journalID TEXT NOT NULL,entryKey TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,journalID,entryKey)); CREATE TABLE expected(keyHash TEXT PRIMARY KEY,domainID TEXT NOT NULL,entryKey TEXT NOT NULL,hash TEXT NOT NULL)",
    )
    const selected = database
    return {
      database: selected,
      async [Symbol.asyncDispose]() {
        try {
          selected.close()
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    database?.close()
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

function expectedProjection(database: Database) {
  type Row = { domainID: string; entryKey: string; hash: string }
  const get = database.query<Row, [string]>("SELECT domainID,entryKey,hash FROM expected WHERE keyHash=?")
  const insert = database.query("INSERT OR IGNORE INTO expected VALUES(?,?,?,?)")
  const write = database.query("INSERT OR REPLACE INTO expected VALUES(?,?,?,?)")
  const remove = database.query("DELETE FROM expected WHERE keyHash=?")
  let consistent = true
  const projection: Projection = {
    baseline(value) {
      if (
        domainFor(value.key)?.id !== value.domainID ||
        insert.run(keyHash(value.key), value.domainID, JSON.stringify(value.key), value.hash).changes !== 1
      )
        consistent = false
    },
    change(value) {
      const key = keyHash(value.key)
      const previous = get.get(key)
      if (
        domainFor(value.key)?.id !== value.domainID ||
        previous?.hash !== value.beforeHash ||
        (previous && (previous.domainID !== value.domainID || previous.entryKey !== JSON.stringify(value.key))) ||
        (value.beforeHash === undefined
          ? value.before !== undefined
          : value.before === undefined || digest(value.before) !== value.beforeHash) ||
        (value.afterHash === undefined
          ? value.after !== undefined
          : value.after === undefined || digest(value.after) !== value.afterHash)
      )
        consistent = false
      if (value.afterHash === undefined) remove.run(key)
      else write.run(key, value.domainID, JSON.stringify(value.key), value.afterHash)
    },
  }
  return {
    projection,
    get consistent() {
      return consistent
    },
    matches(value: z.infer<typeof Fingerprint>) {
      const expected = get.get(keyHash(value.key))
      return (
        expected?.domainID === value.domainID &&
        expected.entryKey === JSON.stringify(value.key) &&
        expected.hash === value.hash
      )
    },
    entries() {
      const query = database.query<Row, []>("SELECT domainID,entryKey,hash FROM expected ORDER BY keyHash")
      return (function* () {
        try {
          for (const row of query.iterate())
            yield { domainID: row.domainID, key: Key.parse(JSON.parse(row.entryKey)), hash: row.hash }
        } finally {
          query.finalize()
        }
      })()
    },
  }
}

async function validChain(
  head: Header,
  baselineRows: AsyncIterable<ChainRow>,
  entryRows: AsyncIterable<ChainRow>,
  options: { assert?: () => void; after?: Header; projection?: Projection } = {},
) {
  const { assert, after, projection } = options
  const baseline = createHash("sha256").update(
    JSON.stringify(["synergy-authority-baseline-v1", head.journalID, head.namespaceID, head.contractHash]),
  )
  let count = 0
  let valid = true
  for await (const row of baselineRows) {
    assert?.()
    const entry = Baseline.parse(row.value)
    projection?.baseline(entry.fingerprint)
    if (
      row.key.length !== 4 ||
      row.key[0] !== root[0] ||
      row.key[1] !== "baseline" ||
      row.key[2] !== head.journalID ||
      entry.sequence !== ++count ||
      row.key.at(-1) !== ordinal(count)
    )
      valid = false
    baseline.update(JSON.stringify(entry.fingerprint))
  }
  valid = valid && count === head.baselineEntries && baseline.digest("hex") === head.baselineHash
  let previous = head.baselineHash
  let sequence = 0
  let anchored = !after || (after.sequence === 0 && after.tailHash === previous)
  for await (const row of entryRows) {
    assert?.()
    const entry = Entry.parse(row.value)
    projection?.change(entry)
    const { hash, ...body } = entry
    if (
      entry.journalID !== head.journalID ||
      row.key.length !== 4 ||
      row.key[0] !== root[0] ||
      row.key[1] !== "entries" ||
      row.key[2] !== head.journalID ||
      entry.sequence !== ++sequence ||
      entry.previousHash !== previous ||
      digest(body) !== hash ||
      row.key.at(-1) !== ordinal(sequence)
    )
      valid = false
    previous = hash
    if (after?.sequence === sequence && after.tailHash === hash) anchored = true
  }
  assert?.()
  return valid && anchored && sequence === head.sequence && previous === head.tailHash
}
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
const adoptionMutation = new AsyncLocalStorage<{
  tx: StoreTransaction
  key: string
  open: boolean
  consumed: boolean
}>()
const adoptionTransactions = new WeakMap<StoreTransaction, object>()
const priorAuthorityMutations = new WeakSet<StoreTransaction>()
interface ArchivedInput {
  directory: string
  expected: StorageCheckpoint.Manifest
  keys: VaultKeyProvider
  signal?: AbortSignal
  after?: Header
}

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

async function* inspectionPages<T>(entries: AsyncIterable<T> | Iterable<T>) {
  let page: T[] = []
  for await (const entry of entries) {
    page.push(entry)
    if (page.length === 128) {
      yield page
      page = []
    }
  }
  if (page.length) yield page
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
  const protectedKey = (key: readonly string[]) =>
    startsWith(key, root) ||
    startsWith(root, key) ||
    domains().some((domain) =>
      domain.prefixes.some((prefix) => startsWith(key, prefix) || (tree && startsWith(prefix, key))),
    )
  if (adoptionTransactions.has(tx)) {
    const permitted = adoptionMutation.getStore()
    if (keys.some(protectedKey)) {
      if (
        permitted?.open &&
        !permitted.consumed &&
        permitted.tx === tx &&
        !tree &&
        keys.every((key) => JSON.stringify(key) === permitted.key)
      ) {
        permitted.consumed = true
        return
      }
      throw new StorageConflictError("Authority adoption seals its original policy and journal transaction")
    }
  } else if (keys.some(protectedKey)) priorAuthorityMutations.add(tx)
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
  async function withArchivedIndex<T>(
    input: ArchivedInput,
    retain: boolean,
    body: (database: Database, checkpoint: Checkpoint) => Promise<T>,
  ): Promise<T> {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const signal = input.signal
    const after = input.after && Checkpoint.parse(input.after)
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    signal?.throwIfAborted()
    await using index = await historyIndex()
    {
      signal?.throwIfAborted()
      const database = index.database
      using insert = database.query("INSERT INTO history VALUES(?,?,?,?)")
      let checkpoint: Checkpoint | undefined
      for await (const entry of StorageCheckpoint.entries({ directory, expected, keys, signal })) {
        signal?.throwIfAborted()
        if (entry.type !== "record") continue
        if (entry.key[0] !== root[0]) {
          const domain = domainFor(entry.key)
          const value = domain && project(domain, entry.key, entry.value)
          if (value !== undefined && domain) {
            insert.run(
              "projected",
              "",
              JSON.stringify(entry.key),
              JSON.stringify(Fingerprint.parse({ domainID: domain.id, key: entry.key, hash: digest(value) })),
            )
            if (retain) insert.run("policy", "", JSON.stringify(entry.key), JSON.stringify(entry.value))
          }
        } else if (JSON.stringify(entry.key) === JSON.stringify(headerKey)) {
          if (checkpoint) throw new StorageIntegrityError("A checkpoint contains repeated authority history")
          checkpoint = Checkpoint.parse(entry.value)
        } else {
          const [, kind, journalID] = entry.key
          if ((kind === "baseline" || kind === "entries" || kind === "fingerprints") && journalID !== undefined)
            insert.run(kind, journalID, JSON.stringify(entry.key), JSON.stringify(entry.value))
        }
      }
      signal?.throwIfAborted()
      if (!checkpoint) throw new StorageIntegrityError("A checkpoint has no authority history")
      if (
        checkpoint.untracked ||
        checkpoint.contractHash !== contractHash() ||
        (after &&
          (after.untracked ||
            after.sequence > checkpoint.sequence ||
            ["journalID", "namespaceID", "contractHash", "baselineHash", "baselineEntries", "startedAt"].some(
              (key) => Reflect.get(after, key) !== Reflect.get(checkpoint, key),
            )))
      )
        throw new StorageIntegrityError("Archived authority history cannot continue the selected checkpoint")
      using query = database.query<{ entryKey: string; value: string }, [string, string]>(
        "SELECT entryKey,value FROM history WHERE kind=? AND journalID=? ORDER BY entryKey",
      )
      const selected = checkpoint
      async function* history(kind: string, journalID = selected.journalID): AsyncGenerator<ChainRow> {
        for (const row of query.iterate(kind, journalID)) {
          signal?.throwIfAborted()
          yield { key: Key.parse(JSON.parse(row.entryKey)), value: JSON.parse(row.value) }
        }
      }
      const projection = expectedProjection(database)
      if (
        !(await validChain(checkpoint, history("baseline"), history("entries"), {
          assert: () => signal?.throwIfAborted(),
          after,
          projection: projection.projection,
        }))
      )
        throw new StorageIntegrityError("Archived authority history is incomplete or invalid")
      if (!projection.consistent)
        throw new StorageIntegrityError("Archived authority projections disagree with recorded changes")
      using lookup = database.query<{ value: string }, [string, string, string]>(
        "SELECT value FROM history WHERE kind=? AND journalID=? AND entryKey=?",
      )
      function fingerprint(kind: "fingerprints" | "projected", key: readonly string[]) {
        signal?.throwIfAborted()
        const row = lookup.get(kind, kind === "projected" ? "" : selected.journalID, JSON.stringify(key))
        return row && Fingerprint.parse(JSON.parse(row.value))
      }
      for await (const row of history("fingerprints")) {
        const retained = Fingerprint.parse(row.value)
        const current = fingerprint("projected", retained.key)
        if (
          row.key.length !== 4 ||
          row.key.at(-1) !== keyHash(retained.key) ||
          !current ||
          digest(current) !== digest(retained) ||
          !projection.matches(retained)
        )
          throw new StorageIntegrityError("Archived authority fingerprints disagree with their current policy")
      }
      for (const value of projection.entries()) {
        const retained = fingerprint("fingerprints", [...fingerprints(selected.journalID), keyHash(value.key)])
        if (!retained || !projection.matches(retained))
          throw new StorageIntegrityError("Archived authority history has no final policy fingerprint")
      }
      for await (const row of history("projected", "")) {
        const current = Fingerprint.parse(row.value)
        const retained = fingerprint("fingerprints", [...fingerprints(selected.journalID), keyHash(current.key)])
        if (!retained || digest(current) !== digest(retained))
          throw new StorageIntegrityError("Archived authority policy has no matching fingerprint")
      }
      signal?.throwIfAborted()
      return await body(database, Checkpoint.parse(checkpoint))
    }
  }
  export function readArchivedCheckpoint(input: ArchivedInput): Promise<Checkpoint> {
    return withArchivedIndex(input, false, async (_database, checkpoint) => checkpoint)
  }
  export interface Adoption {
    readonly kind: "authority-adoption"
  }
  const adoptions = new WeakMap<
    Adoption,
    {
      database: Database
      checkpoint: Checkpoint
      after: Checkpoint
      assert(): void
      pending: Set<Promise<unknown>>
    }
  >()
  function originalAdoption(evidence: Adoption) {
    const frame = adoptions.get(evidence)
    if (!frame) throw new StorageConflictError("Authority adoption requires original archive evidence")
    frame.assert()
    return frame
  }
  export function describeAdoption(evidence: Adoption) {
    return Checkpoint.parse(originalAdoption(evidence).checkpoint)
  }
  export async function withAdoption<T>(
    input: ArchivedInput & { after: Checkpoint },
    body: (evidence: Adoption) => Promise<T>,
  ): Promise<T> {
    const after = Checkpoint.parse(input.after)
    const signal = input.signal
    const runtime = RuntimeContext.current()
    const handle = runtime.storage
    const selected = Storage.current()
    const store = selected.store
    const configuration = digest(store.options)
    const artifactDirectory = selected.artifactDirectory
    const objects = selected.artifactObjects
    const ports = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    const contract = contractHash()
    let open = true
    const assert = () => {
      signal?.throwIfAborted()
      if (!open) throw new StorageConflictError("Authority adoption callback has ended")
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== handle ||
        !handle ||
        handle.store !== store ||
        handle.artifactDirectory !== artifactDirectory ||
        handle.artifactObjects !== objects ||
        current.store !== store ||
        digest(store.options) !== configuration ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== ports?.blobs ||
        objects?.writerID !== ports?.writerID ||
        objects?.now !== ports?.now ||
        contractHash() !== contract
      )
        throw new StorageConflictError("Authority adoption belongs to another Runtime or primary Store")
    }
    assert()
    return withArchivedIndex({ ...input, after }, true, async (database, checkpoint) => {
      assert()
      const evidence: Adoption = Object.freeze({ kind: "authority-adoption" })
      const pending = new Set<Promise<unknown>>()
      adoptions.set(evidence, { database, checkpoint, after, assert, pending })
      try {
        return await body(evidence)
      } finally {
        open = false
        await Promise.allSettled([...pending])
      }
    })
  }
  export function adopt(tx: StoreTransaction, evidence: Adoption): Promise<void> {
    const frame = originalAdoption(evidence)
    const store = Storage.current().store
    if (!Storage.inWriteTransaction()) throw new StorageConflictError("Authority adoption requires a write transaction")
    store.assertWriteTransaction(tx)
    if (Storage.current().transaction !== tx || actions.getStore())
      throw new StorageConflictError("Authority adoption requires its original independent recovery transaction")
    const previous = adoptionTransactions.get(tx)
    if (previous && previous !== frame)
      throw new StorageConflictError("Authority adoption transaction already has another owner")
    let completed = false
    let failure: unknown
    const work = Storage.transaction(
      async () => {
        try {
          if (priorAuthorityMutations.has(tx))
            throw new StorageConflictError("Authority adoption refuses a prior authority mutation")
          frame.assert()
          const current = await inspect()
          frame.assert()
          if (
            !current.covered ||
            !current.head ||
            (digest(current.head) !== digest(frame.after) && digest(current.head) !== digest(frame.checkpoint))
          )
            throw new StorageIntegrityError("Authority adoption target cannot continue its original checkpoint")
          adoptionTransactions.set(tx, frame)
          const change = async (key: string[], value: unknown, remove = false) => {
            frame.assert()
            const permit = { tx, key: JSON.stringify(key), open: true, consumed: false }
            try {
              await adoptionMutation.run(permit, () => (remove ? tx.remove(key) : tx.write(key, value)))
            } finally {
              permit.open = false
            }
            frame.assert()
          }
          using lookup = frame.database.query<{ value: string }, [string]>(
            "SELECT value FROM history WHERE kind='policy' AND journalID='' AND entryKey=?",
          )
          for (const domain of domains())
            for (const prefix of domain.prefixes)
              for await (const row of rows(tx, [...prefix])) {
                frame.assert()
                if (project(domain, row.key, row.value) !== undefined && !lookup.get(JSON.stringify(row.key)))
                  await change(row.key, undefined, true)
              }
          using policies = frame.database.query<{ entryKey: string; value: string }, []>(
            "SELECT entryKey,value FROM history WHERE kind='policy' AND journalID='' ORDER BY entryKey",
          )
          for (const row of policies.iterate()) await change(Key.parse(JSON.parse(row.entryKey)), JSON.parse(row.value))
          for (const kind of ["baseline", "entries", "fingerprints"]) {
            for await (const row of rows(tx, [...root, kind, frame.checkpoint.journalID]))
              await change(row.key, undefined, true)
            using history = frame.database.query<{ entryKey: string; value: string }, [string, string]>(
              "SELECT entryKey,value FROM history WHERE kind=? AND journalID=? ORDER BY entryKey",
            )
            for (const row of history.iterate(kind, frame.checkpoint.journalID))
              await change(Key.parse(JSON.parse(row.entryKey)), JSON.parse(row.value))
          }
          await change(headerKey, frame.checkpoint)
          const final = await inspect()
          frame.assert()
          if (!final.covered || digest(final.head) !== digest(frame.checkpoint))
            throw new StorageIntegrityError("Authority adoption did not reconstruct its verified current policy")
          completed = true
        } catch (error) {
          failure = error
          throw error
        }
      },
      {
        commitGuard() {
          frame.assert()
          if (!completed) throw failure ?? new StorageConflictError("Authority adoption did not complete before commit")
        },
      },
    )
    frame.pending.add(work)
    work.then(
      () => frame.pending.delete(work),
      () => frame.pending.delete(work),
    )
    return work
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
      await using index = await historyIndex()
      const expected = expectedProjection(index.database)
      const chainValid = await validChain(
        head,
        rows(tx, [...root, "baseline", head.journalID]),
        rows(tx, records(head.journalID)),
        { projection: expected.projection },
      )
      let fingerprintGaps = 0
      for await (const page of inspectionPages(rows(tx, fingerprints(head.journalID)))) {
        const retained = page.map((row) => Fingerprint.parse(row.value))
        const values = await tx.readMany(retained.map((value) => value.key))
        for (const [index, fingerprint] of retained.entries()) {
          const row = page[index]!
          const value = values[index]
          const domain = registry().domains.get(fingerprint.domainID)
          const current = value === undefined || !domain ? undefined : project(domain, fingerprint.key, value)
          if (
            current === undefined ||
            digest(current) !== fingerprint.hash ||
            row.key.length !== 4 ||
            row.key.at(-1) !== keyHash(fingerprint.key) ||
            !expected.matches(fingerprint)
          )
            fingerprintGaps++
        }
      }
      for await (const page of inspectionPages(expected.entries())) {
        const values = await tx.readMany(page.map((value) => [...fingerprints(head.journalID), keyHash(value.key)]))
        for (const value of values) {
          const retained = value === undefined ? undefined : Fingerprint.parse(value)
          if (!retained || !expected.matches(retained)) fingerprintGaps++
        }
      }
      for (const domain of domains())
        for (const prefix of domain.prefixes)
          for await (const page of inspectionPages(rows(tx, [...prefix]))) {
            const projected = page.filter((row) => project(domain, row.key, row.value) !== undefined)
            if (!projected.length) continue
            const values = await tx.readMany(
              projected.map((row) => [...fingerprints(head.journalID), keyHash(row.key)]),
            )
            for (const value of values) {
              const expected = value === undefined ? undefined : Fingerprint.parse(value)
              if (!expected) fingerprintGaps++
            }
          }
      return {
        head,
        initialized: true,
        fingerprintGaps,
        chainValid,
        covered:
          head.contractHash === contractHash() &&
          !head.untracked &&
          fingerprintGaps === 0 &&
          chainValid &&
          expected.consistent,
      }
    })
  }
}
