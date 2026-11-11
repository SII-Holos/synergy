import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import type { BlobStore } from "../storage/blobs"
import { Lock } from "../util/lock"
import { JsonValue } from "../util/json-value"
import { SessionTransferStream as Stream } from "./transfer-stream"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferEpochs } from "./transfer-epochs"
import { SessionTransferAggregate as Aggregate } from "./transfer-aggregate"
import { SessionTransferCore as Core } from "./transfer-core"
import { Session } from "."
import { initializeSqliteEngine } from "../storage/sqlite-engine"

export namespace SessionTransferStaging {
  export const Rejected = NamedError.create("SessionTransferStagingRejected", z.object({ message: z.string() }))
  const ID = z.string().min(1).max(4096)
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Key = z.array(ID).min(1)
  const State = z.strictObject({
    version: z.literal(1),
    handoffID: ID,
    root: Stream.Root,
    rootHash: Hash,
    phase: z.enum(["receiving", "verified", "activated"]),
  })
  const Entry = z.strictObject({
    version: z.literal(1),
    id: ID,
    ownerID: ID,
    sessionID: ID,
    kind: z.enum(["record", "artifact", "file", "history"]),
    key: Key,
    ordinal: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().safe(),
    sha256: Hash,
    metadata: z.record(z.string(), JsonValue),
  })
  type Entry = z.infer<typeof Entry>
  const Destination = Entry.pick({ version: true, id: true, ownerID: true, sessionID: true, ordinal: true })
  const contexts = new WeakMap<
    Owners.TargetContext,
    { runtime: RuntimeContext.Instance; handoffID: string; rootHash: string; ownerID: string; assertOwner(): void }
  >()
  const aggregates = new WeakMap<
    Owners.TargetContext,
    { runtime: RuntimeContext.Instance; rootHash: string; rootSessionID: string; scopeID: string; digest: string }
  >()
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const stateKey = (handoffID: string) => ["session_transfer_staging", ID.parse(handoffID), "state"]
  const entriesKey = (handoffID: string, ownerID?: string, sessionID?: string) => [
    "session_transfer_staging",
    ID.parse(handoffID),
    "entries",
    ...(ownerID ? [ownerID] : []),
    ...(sessionID ? [sessionID] : []),
  ]
  const entryKey = (handoffID: string, entry: Pick<Entry, "ownerID" | "sessionID" | "ordinal">) => [
    ...entriesKey(handoffID, entry.ownerID, entry.sessionID),
    String(entry.ordinal).padStart(16, "0"),
  ]
  const ownersKey = (handoffID: string) => ["session_transfer_staging", handoffID, "owners"]
  const bytesKey = (handoffID: string, entry: Entry) => [
    "session_transfer_staging",
    handoffID,
    "bytes",
    digest(entry.id),
  ]
  const destinationKey = (handoffID: string, entry: Pick<Entry, "kind" | "key">) => [
    "session_transfer_staging",
    handoffID,
    "destinations",
    digest([entry.kind === "record" ? "record" : "binary", entry.key]),
  ]
  function fail(message: string): never {
    throw new Rejected({ message })
  }

  function immutable<T>(value: T): T {
    const result = structuredClone(value)
    const pending: unknown[] = [result]
    const visited = new WeakSet<object>()
    while (pending.length) {
      const current = pending.pop()
      if (!current || typeof current !== "object" || visited.has(current)) continue
      visited.add(current)
      for (const nested of Object.values(current)) pending.push(nested)
      Object.freeze(current)
    }
    return result
  }

  function compatible(owners: Readonly<Record<string, number>>) {
    const requirements = Owners.compatibility(owners)
    if (requirements.length)
      throw new Owners.Rejected({ message: "Destination portability is incompatible", requirements })
  }

  async function state(handoffID: string) {
    return State.parse(await Storage.read(stateKey(handoffID)))
  }

  export async function inspect(handoffID: string) {
    return state(handoffID)
  }

  export async function receive(input: {
    handoffID: string
    root: Stream.Root
    store: BlobStore
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()
    const handoffID = ID.parse(input.handoffID)
    const root = Stream.Root.parse(input.root)
    compatible(root.owners)
    Owners.publicationOrder(Object.keys(root.owners))
    const rootHash = Stream.digest(root)
    using lock = input.signal
      ? await Lock.writeWithSignal(`session-transfer-staging:${handoffID}`, input.signal)
      : await Lock.write(`session-transfer-staging:${handoffID}`)
    input.signal?.throwIfAborted()
    if (!lock) fail("Destination receive could not acquire its native lock")
    const [stored] = await Storage.readMany([stateKey(handoffID)])
    if (stored !== undefined) {
      const previous = State.parse(stored)
      if (previous.rootHash !== rootHash) fail("A handoff cannot replace its staged manifest")
      if (previous.phase !== "receiving") return previous
    }
    await Storage.write(stateKey(handoffID), State.parse({ version: 1, handoffID, root, rootHash, phase: "receiving" }))
    await fs.mkdir(Global.Path.cache, { recursive: true })
    await using reader = await Stream.open({
      root,
      store: input.store,
      directory: Global.Path.cache,
      signal: input.signal,
    })
    let ordinal = 0
    for await (const source of reader.entries()) {
      input.signal?.throwIfAborted()
      const ownerID = ID.parse(source.metadata.transferOwner)
      if (!Object.hasOwn(root.owners, ownerID)) fail("A portable entry claims an undeclared owner")
      const entry = Entry.parse({
        version: 1,
        id: source.id,
        ownerID,
        sessionID: ID.parse(source.metadata.transferSessionID),
        kind: source.kind,
        key: Key.parse(source.metadata.key),
        ordinal: ordinal++,
        bytes: source.bytes,
        sha256: source.hash,
        metadata: source.metadata,
      })
      const [destination, retained] = await Storage.readMany([
        destinationKey(handoffID, entry),
        entryKey(handoffID, entry),
      ])
      if (destination !== undefined && Destination.parse(destination).id !== entry.id)
        fail("Duplicate portable destination key")
      if (retained !== undefined && digest(Entry.parse(retained)) !== digest(entry))
        fail("A staged entry changed during retry")
      using prepared = await Storage.prepareBinaryStream(bytesKey(handoffID, entry), source.content, {
        signal: input.signal,
      })
      await Storage.transaction(async () => {
        await Storage.publishPreparedBinary(prepared)
        await Storage.write(entryKey(handoffID, entry), entry)
        await Storage.write([...ownersKey(handoffID), ownerID, entry.sessionID], { version: 1 })
        await Storage.write(
          destinationKey(handoffID, entry),
          Destination.parse({
            version: 1,
            id: entry.id,
            ownerID: entry.ownerID,
            sessionID: entry.sessionID,
            ordinal: entry.ordinal,
          }),
        )
      })
    }
    if (!reader.verified()) fail("Portable staging did not verify the complete manifest")
    const verified = State.parse({ version: 1, handoffID, root, rootHash, phase: "verified" })
    await Storage.write(stateKey(handoffID), verified)
    return verified
  }

  async function* entries(handoffID: string, ownerID?: string, sessionID?: string) {
    for await (const row of Storage.records({ prefix: entriesKey(handoffID, ownerID, sessionID), limit: 128 }))
      yield Entry.parse(row.value)
  }

  async function readRecord(handoffID: string, entry: Entry): Promise<Owners.StagedRecord> {
    const bytes = await Storage.readBinary(bytesKey(handoffID, entry))
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      fail("Staged portable record changed")
    return {
      key: [...entry.key],
      value: JsonValue.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    }
  }

  async function boundRecord(handoffID: string, ownerID: string, sessionID: string, key: string[]) {
    const [reference] = await Storage.readMany([destinationKey(handoffID, { kind: "record", key: Key.parse(key) })])
    if (reference === undefined) return
    const destination = Destination.parse(reference)
    if (destination.ownerID !== ownerID || destination.sessionID !== sessionID) return
    const entry = Entry.parse(await Storage.read(entryKey(handoffID, destination)))
    if (
      entry.ownerID !== ownerID ||
      entry.sessionID !== sessionID ||
      entry.kind !== "record" ||
      JSON.stringify(entry.key) !== JSON.stringify(key) ||
      entry.id !== destination.id
    )
      fail("Staged portable destination index changed")
    return readRecord(handoffID, entry)
  }

  async function boundArtifact(handoffID: string, ownerID: string, sessionID: string, key: string[]) {
    const [reference] = await Storage.readMany([destinationKey(handoffID, { kind: "artifact", key: Key.parse(key) })])
    if (reference === undefined) return
    const destination = Destination.parse(reference)
    if (destination.ownerID !== ownerID || destination.sessionID !== sessionID) return
    const entry = Entry.parse(await Storage.read(entryKey(handoffID, destination)))
    if (
      entry.ownerID !== ownerID ||
      entry.sessionID !== sessionID ||
      entry.kind === "record" ||
      JSON.stringify(entry.key) !== JSON.stringify(key) ||
      entry.id !== destination.id
    )
      fail("Staged portable binary destination index changed")
    return entry
  }

  async function* boundRecords(handoffID: string, ownerID: string, sessionID: string, signal: AbortSignal) {
    for await (const entry of entries(handoffID, ownerID, sessionID)) {
      signal.throwIfAborted()
      if (entry.ownerID !== ownerID || entry.sessionID !== sessionID)
        fail("Staged partition belongs to another owner or Session")
      if (entry.kind === "record") yield await readRecord(handoffID, entry)
    }
  }

  export async function prepareAggregate(input: {
    handoffID: string
    rootSessionID: string
    scopeID: string
    signal: AbortSignal
  }) {
    if (Storage.inTransaction()) fail("Aggregate preparation must precede the activation transaction")
    const current = await state(input.handoffID)
    if (current.phase !== "verified") fail("Portable aggregate staging is not verified")
    if ((current.root.owners["session-core"] ?? 0) < 2) fail("Aggregate preparation requires sealed Core membership")
    compatible(current.root.owners)
    Owners.publicationOrder(Object.keys(current.root.owners))
    const runtime = RuntimeContext.current()
    for await (const row of Storage.records({ prefix: ownersKey(input.handoffID), limit: 128 })) {
      input.signal.throwIfAborted()
      const sessionID = row.key.at(-1)!
      const [core] = await Storage.readMany([[...ownersKey(input.handoffID), "session-core", sessionID]])
      if (core === undefined) fail("Portable aggregate native owner has no canonical Core member")
    }
    const result = await Aggregate.validate({
      ...input,
      members: (async function* () {
        for await (const row of Storage.records({
          prefix: [...ownersKey(input.handoffID), "session-core"],
          limit: 128,
        })) {
          input.signal.throwIfAborted()
          const sessionID = row.key.at(-1)!
          const owners: Record<string, number> = {}
          for (const [ownerID, version] of Object.entries(current.root.owners)) {
            const [member] = await Storage.readMany([[...ownersKey(input.handoffID), ownerID, sessionID]])
            if (member !== undefined) owners[ownerID] = version
          }
          yield await Core.aggregateMember({
            sessionID,
            owners,
            signal: input.signal,
            records: {
              record: (key) => boundRecord(input.handoffID, "session-core", sessionID, key),
              records: () => boundRecords(input.handoffID, "session-core", sessionID, input.signal),
            },
          })
        }
      })(),
    })
    input.signal.throwIfAborted()
    if (RuntimeContext.current() !== runtime || (await state(input.handoffID)).rootHash !== current.rootHash)
      fail("Portable aggregate preparation identity changed")
    return {
      ...result,
      rootHash: current.rootHash,
      rootSessionID: input.rootSessionID,
      scopeID: input.scopeID,
    }
  }

  export function members(value: {
    handoffID: string
    rootSessionID: string
    scopeID: string
    signal: AbortSignal
  }): AsyncGenerator<{ session: Readonly<Session.Info>; owners: Readonly<Record<string, number>> }> {
    const input = {
      handoffID: ID.parse(value.handoffID),
      rootSessionID: ID.parse(value.rootSessionID),
      scopeID: ID.parse(value.scopeID),
      signal: value.signal,
    }
    const runtime = RuntimeContext.current()
    const captured = Storage.current()
    const storage = {
      store: captured.store,
      artifactDirectory: captured.artifactDirectory,
      artifactObjects: captured.artifactObjects,
    }
    function assertOwner() {
      input.signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== storage.store ||
        current.artifactDirectory !== storage.artifactDirectory ||
        current.artifactObjects !== storage.artifactObjects
      )
        fail("Staged members belong to another Runtime or Store")
    }
    return (async function* () {
      assertOwner()
      const prepared = await prepareAggregate(input)
      assertOwner()
      const initial = await state(input.handoffID)
      assertOwner()
      await initializeSqliteEngine()
      await fs.mkdir(Global.Path.cache, { recursive: true })
      const directory = await fs.mkdtemp(path.join(Global.Path.cache, "session-transfer-members-"))
      const database = new Database(path.join(directory, "members.sqlite"))
      try {
        database.exec(
          "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE members(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,parent TEXT)",
        )
        using insert = database.prepare("INSERT INTO members(id,parent) VALUES (?,?)")
        using next = database.prepare<{ ordinal: number; id: string; parent: string | null }, [number]>(
          "SELECT ordinal,id,parent FROM members WHERE ordinal>? ORDER BY ordinal LIMIT 1",
        )
        insert.run(input.rootSessionID, null)
        let ordinal = 0
        let count = 0
        for (;;) {
          assertOwner()
          const row = next.get(ordinal)
          if (!row) break
          ordinal = row.ordinal
          const record = await boundRecord(input.handoffID, "session-core", row.id, [
            "sessions",
            input.scopeID,
            row.id,
            "info",
          ])
          if (!record) fail("Staged member has no canonical Core metadata")
          const session = Session.PersistedInfo.parse({
            ...z.record(z.string(), z.unknown()).parse(record.value),
            workspace: null,
          })
          if (session.id !== row.id || session.scope.id !== input.scopeID || (session.parentID ?? null) !== row.parent)
            fail("Staged member metadata disagrees with its verified parent lineage")
          const owners: Record<string, number> = {}
          for (const [ownerID, version] of Object.entries(initial.root.owners)) {
            const [selected] = await Storage.readMany([[...ownersKey(input.handoffID), ownerID, row.id]])
            if (selected !== undefined) owners[ownerID] = version
          }
          const membership = Aggregate.portableKey(session)
          for await (const entry of entries(input.handoffID, "session-core", row.id)) {
            assertOwner()
            if (
              entry.kind !== "record" ||
              !membership.every((segment, index) => entry.key[index] === segment) ||
              entry.key[3] !== "edges" ||
              entry.key[4] !== "child"
            )
              continue
            const edge = Aggregate.Edge.parse((await readRecord(input.handoffID, entry)).value)
            if (
              entry.key.length !== 7 ||
              edge.kind !== "child" ||
              edge.ownerID !== "session-core" ||
              entry.key[5] !== edge.ownerID ||
              entry.key[6] !== edge.sessionID
            )
              fail("Staged canonical child edge changed")
            insert.run(edge.sessionID, session.id)
          }
          assertOwner()
          const current = await state(input.handoffID)
          if (current.rootHash !== prepared.rootHash || current.phase !== "verified")
            fail("Staged member preparation changed")
          count++
          yield { session, owners }
        }
        if (count !== prepared.members) fail("Staged member traversal omitted its verified native cohort")
      } finally {
        database.close(true)
        await fs.rm(directory, { recursive: true, force: true })
      }
    })()
  }

  export async function verify(handoffID: string, signal?: AbortSignal) {
    const current = await state(handoffID)
    compatible(current.root.owners)
    Owners.publicationOrder(Object.keys(current.root.owners))
    if (current.phase === "receiving") fail("Portable staging is incomplete")
    let count = 0
    let total = 0
    for await (const entry of entries(handoffID)) {
      const hash = createHash("sha256")
      let bytes = 0
      for await (const chunk of Storage.readBinaryStream(bytesKey(handoffID, entry), { signal })) {
        hash.update(chunk)
        bytes += chunk.length
      }
      if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) fail("Staged portable content changed")
      count++
      total += bytes
    }
    if (count !== current.root.entries || total !== current.root.bytes) fail("Staged portable inventory is incomplete")
    return current
  }

  export async function context(input: Omit<Owners.TargetContext, "sourceVersion" | "staged"> & { ownerID: string }) {
    const signal = input.signal
    signal.throwIfAborted()
    const ownerID = ID.parse(input.ownerID)
    const handoffID = ID.parse(input.handoffID)
    const rootSessionID = ID.parse(input.rootSessionID)
    const session = immutable(input.session)
    const sessionID = ID.parse(session.id)
    const scopeID = ID.parse(session.scope.id)
    const mapping = immutable(z.record(z.string(), JsonValue).parse(input.mapping))
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const objects = handle.artifactObjects
    const storage = {
      store: handle.store,
      artifactDirectory: handle.artifactDirectory,
      artifactObjects: objects,
      blobs: objects?.blobs,
      writerID: objects?.writerID,
      now: objects?.now,
    }
    function assertOwner() {
      signal.throwIfAborted()
      if (RuntimeContext.current() !== runtime) fail("Staged context belongs to another storage owner")
      const current = Storage.current()
      if (
        current.store !== storage.store ||
        current.artifactDirectory !== storage.artifactDirectory ||
        current.artifactObjects !== storage.artifactObjects ||
        objects?.blobs !== storage.blobs ||
        objects?.writerID !== storage.writerID ||
        objects?.now !== storage.now
      )
        fail("Staged context belongs to another storage owner")
    }
    assertOwner()
    const current = await state(handoffID)
    assertOwner()
    Owners.publicationOrder(Object.keys(current.root.owners))
    if (current.phase !== "verified") fail("Portable staging is not prepared for owner validation")
    if (!Object.hasOwn(current.root.owners, ownerID)) fail("Portable owner is absent from the manifest")
    const sourceVersion = current.root.owners[ownerID]
    compatible({ [ownerID]: sourceVersion })
    function assertDependency(dependency: string) {
      assertOwner()
      if (!Owners.stagedDependencies(ownerID).includes(dependency))
        fail("Portable owner has not declared this staged dependency")
      if (!Object.hasOwn(current.root.owners, dependency))
        fail("Declared staged dependency is absent from the verified manifest")
      compatible({ [dependency]: current.root.owners[dependency] })
    }
    function artifact(entry: Entry): Owners.StagedArtifact {
      return {
        key: [...entry.key],
        bytes: entry.bytes,
        sha256: entry.sha256,
        read() {
          assertOwner()
          const reader = Storage.readBinaryStream(bytesKey(handoffID, entry), { signal })
          return (async function* () {
            try {
              assertOwner()
              for (;;) {
                assertOwner()
                const next = await reader.next()
                assertOwner()
                if (next.done) break
                yield next.value
              }
              assertOwner()
            } finally {
              await reader.return(undefined)
            }
          })()
        },
        async publish(target, options) {
          assertOwner()
          const destination = Key.parse(target)
          const replace = options?.replace
          if (!Storage.inWriteTransaction()) fail("Portable artifact publication requires the activation transaction")
          await Storage.transaction(
            () => Storage.publishBinaryReference(bytesKey(handoffID, entry), destination, { replace }),
            { commitGuard: assertOwner },
          )
          assertOwner()
        },
      }
    }
    async function readBoundRecord(boundOwner: string, key: string[]) {
      assertOwner()
      const selected = Key.parse(key)
      const record = await boundRecord(handoffID, boundOwner, sessionID, selected)
      assertOwner()
      return record
    }
    function ownedEntries(boundOwner: string) {
      return (async function* () {
        const reader = entries(handoffID, boundOwner, sessionID)
        try {
          for (;;) {
            assertOwner()
            const next = await reader.next()
            assertOwner()
            if (next.done) break
            const entry = next.value
            if (entry.ownerID !== boundOwner || entry.sessionID !== sessionID)
              fail("Staged partition belongs to another owner or Session")
            yield entry
          }
        } finally {
          await reader.return(undefined)
        }
      })()
    }
    function records(boundOwner: string) {
      return (async function* () {
        for await (const entry of ownedEntries(boundOwner)) {
          if (entry.kind !== "record") continue
          assertOwner()
          const record = await readRecord(handoffID, entry)
          assertOwner()
          yield record
        }
        assertOwner()
      })()
    }
    const staged: Owners.TargetContext["staged"] = {
      async ownerVersion(dependency) {
        assertOwner()
        dependency = ID.parse(dependency)
        if (!Object.hasOwn(current.root.owners, dependency)) return
        const [member] = await Storage.readMany([[...ownersKey(handoffID), dependency, sessionID]])
        assertOwner()
        return member === undefined ? undefined : current.root.owners[dependency]
      },
      async record(key) {
        return readBoundRecord(ownerID, key)
      },
      async artifact(key) {
        assertOwner()
        const selected = Key.parse(key)
        const entry = await boundArtifact(handoffID, ownerID, sessionID, selected)
        assertOwner()
        return entry && artifact(entry)
      },
      async relatedRecord(dependency, key) {
        assertDependency(dependency)
        return readBoundRecord(dependency, key)
      },
      records() {
        return records(ownerID)
      },
      relatedRecords(dependency) {
        return (async function* () {
          assertDependency(dependency)
          yield* records(dependency)
        })()
      },
      artifacts() {
        assertOwner()
        return (async function* () {
          assertOwner()
          for await (const entry of ownedEntries(ownerID)) {
            if (entry.kind === "record") continue
            yield artifact(entry)
          }
          assertOwner()
        })()
      },
    }
    const context: Owners.TargetContext = Object.freeze({
      session,
      rootSessionID,
      handoffID,
      mapping,
      signal,
      sourceVersion,
      staged: Object.freeze(staged),
    })
    contexts.set(context, {
      runtime: RuntimeContext.current(),
      handoffID,
      rootHash: current.rootHash,
      ownerID,
      assertOwner,
    })
    if (ownerID === "session-core" && sourceVersion >= 2 && sessionID === rootSessionID) {
      assertOwner()
      const prepared = await prepareAggregate({ handoffID, rootSessionID, scopeID, signal })
      assertOwner()
      aggregates.set(context, {
        runtime,
        ...prepared,
      })
    }
    assertOwner()
    return context
  }

  export async function publish(input: {
    handoffID: string
    contexts: { ownerID: string; context: Owners.TargetContext }[]
  }) {
    const handoffID = ID.parse(input.handoffID)
    const publications = input.contexts.map(({ ownerID, context }) => ({ ownerID: ID.parse(ownerID), context }))
    if (!Storage.inWriteTransaction()) fail("Portable publication requires the activation transaction")
    for (const { context } of publications) {
      const evidence = contexts.get(context)
      if (!evidence) fail("Portable publication requires exact prepared owner contexts")
      await Storage.transaction(async () => evidence.assertOwner(), { commitGuard: evidence.assertOwner })
    }
    const current = await state(handoffID)
    if (current.phase !== "verified") fail("Portable staging cannot be published in this phase")
    Owners.publicationOrder(Object.keys(current.root.owners))
    const selected = new Set<string>()
    const pairs = new Set<string>()
    for (const { ownerID, context } of publications) {
      const evidence = contexts.get(context)
      const pair = JSON.stringify([ownerID, context.session.id])
      if (
        !evidence ||
        evidence.runtime !== RuntimeContext.current() ||
        evidence.handoffID !== handoffID ||
        evidence.rootHash !== current.rootHash ||
        evidence.ownerID !== ownerID ||
        pairs.has(pair)
      )
        fail("Portable publication requires exact prepared owner contexts")
      SessionTransferEpochs.assertActivation({ sessionID: context.session.id, handoffID })
      selected.add(ownerID)
      pairs.add(pair)
    }
    if (Object.keys(current.root.owners).some((id) => !selected.has(id)))
      fail("Portable publication omitted a required owner")
    const publicationOrder = Owners.publicationOrder([...selected])
    if ((current.root.owners["session-core"] ?? 0) >= 2) {
      const root = publications.find(
        ({ ownerID, context }) => ownerID === "session-core" && context.session.id === context.rootSessionID,
      )
      const aggregate = root && aggregates.get(root.context)
      if (!aggregate || aggregate.runtime !== RuntimeContext.current() || aggregate.rootHash !== current.rootHash)
        fail("Portable publication requires an exact prepared aggregate membership proof")
      if (
        publications.some(
          ({ context }) =>
            context.rootSessionID !== aggregate.rootSessionID || context.session.scope.id !== aggregate.scopeID,
        )
      )
        fail("Portable publication contains another aggregate or Scope")
    }
    for await (const row of Storage.records({ prefix: ownersKey(handoffID), limit: 128 })) {
      if (!pairs.has(JSON.stringify(row.key.slice(-2)))) fail("Portable publication omitted a required Session owner")
    }
    for (const id of publicationOrder)
      for (const { ownerID, context } of publications) if (ownerID === id) await Owners.publish(ownerID, context)
    const published = State.parse({ ...current, phase: "activated" })
    await Storage.write(stateKey(handoffID), published)
  }
}
