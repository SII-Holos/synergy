import { createHash } from "node:crypto"
import fs from "node:fs/promises"
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
    { runtime: RuntimeContext.Instance; handoffID: string; rootHash: string; ownerID: string }
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
    const handoffID = ID.parse(input.handoffID)
    const root = Stream.Root.parse(input.root)
    compatible(root.owners)
    const rootHash = Stream.digest(root)
    using lock = await Lock.write(`session-transfer-staging:${handoffID}`)
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

  export async function verify(handoffID: string, signal?: AbortSignal) {
    const current = await state(handoffID)
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
    const current = await state(input.handoffID)
    if (current.phase !== "verified") fail("Portable staging is not prepared for owner validation")
    if (!Object.hasOwn(current.root.owners, input.ownerID)) fail("Portable owner is absent from the manifest")
    const sourceVersion = current.root.owners[input.ownerID]
    compatible({ [input.ownerID]: sourceVersion })
    const { ownerID, ...base } = input
    const runtime = RuntimeContext.current()
    function assertOwner() {
      if (RuntimeContext.current() !== runtime) fail("Staged owner context belongs to another Runtime")
      input.signal.throwIfAborted()
    }
    const context: Owners.TargetContext = {
      ...base,
      sourceVersion,
      staged: {
        async ownerVersion(dependency) {
          assertOwner()
          if (!Object.hasOwn(current.root.owners, dependency)) return
          const [member] = await Storage.readMany([[...ownersKey(input.handoffID), dependency, input.session.id]])
          assertOwner()
          return member === undefined ? undefined : current.root.owners[dependency]
        },
        async record(key) {
          assertOwner()
          const [reference] = await Storage.readMany([
            destinationKey(input.handoffID, { kind: "record", key: Key.parse(key) }),
          ])
          if (reference === undefined) return
          const destination = Destination.parse(reference)
          if (destination.ownerID !== ownerID || destination.sessionID !== input.session.id) return
          const entry = Entry.parse(await Storage.read(entryKey(input.handoffID, destination)))
          if (
            entry.kind !== "record" ||
            JSON.stringify(entry.key) !== JSON.stringify(key) ||
            entry.id !== destination.id
          )
            fail("Staged portable destination index changed")
          return readRecord(input.handoffID, entry)
        },
        async *records() {
          assertOwner()
          for await (const entry of entries(input.handoffID, ownerID, input.session.id)) {
            assertOwner()
            if (entry.kind !== "record") continue
            yield await readRecord(input.handoffID, entry)
          }
        },
        async *relatedRecords(dependency) {
          assertOwner()
          if (!Owners.stagedDependencies(ownerID).includes(dependency))
            fail("Portable owner has not declared this staged dependency")
          if (!Object.hasOwn(current.root.owners, dependency))
            fail("Declared staged dependency is absent from the verified manifest")
          compatible({ [dependency]: current.root.owners[dependency] })
          for await (const entry of entries(input.handoffID, dependency, input.session.id)) {
            assertOwner()
            if (entry.ownerID !== dependency || entry.sessionID !== input.session.id)
              fail("Staged dependency partition belongs to another owner or Session")
            if (entry.kind !== "record") continue
            const record = await readRecord(input.handoffID, entry)
            assertOwner()
            yield record
          }
        },
        async *artifacts() {
          assertOwner()
          for await (const entry of entries(input.handoffID, ownerID, input.session.id)) {
            assertOwner()
            if (entry.kind === "record") continue
            yield {
              key: [...entry.key],
              bytes: entry.bytes,
              sha256: entry.sha256,
              read() {
                assertOwner()
                return Storage.readBinaryStream(bytesKey(input.handoffID, entry), { signal: input.signal })
              },
              async publish(target, options) {
                assertOwner()
                await Storage.publishBinaryReference(bytesKey(input.handoffID, entry), Key.parse(target), options)
              },
            }
          }
        },
      },
    }
    contexts.set(context, {
      runtime: RuntimeContext.current(),
      handoffID: input.handoffID,
      rootHash: current.rootHash,
      ownerID,
    })
    return context
  }

  export async function publish(input: {
    handoffID: string
    contexts: { ownerID: string; context: Owners.TargetContext }[]
  }) {
    if (!Storage.inWriteTransaction()) fail("Portable publication requires the activation transaction")
    const current = await state(input.handoffID)
    if (current.phase !== "verified") fail("Portable staging cannot be published in this phase")
    const selected = new Set<string>()
    const pairs = new Set<string>()
    for (const { ownerID, context } of input.contexts) {
      const evidence = contexts.get(context)
      const pair = JSON.stringify([ownerID, context.session.id])
      if (
        !evidence ||
        evidence.runtime !== RuntimeContext.current() ||
        evidence.handoffID !== input.handoffID ||
        evidence.rootHash !== current.rootHash ||
        evidence.ownerID !== ownerID ||
        pairs.has(pair)
      )
        fail("Portable publication requires exact prepared owner contexts")
      SessionTransferEpochs.assertActivation({ sessionID: context.session.id, handoffID: input.handoffID })
      selected.add(ownerID)
      pairs.add(pair)
    }
    if (Object.keys(current.root.owners).some((id) => !selected.has(id)))
      fail("Portable publication omitted a required owner")
    for await (const row of Storage.records({ prefix: ownersKey(input.handoffID), limit: 128 })) {
      if (!pairs.has(JSON.stringify(row.key.slice(-2)))) fail("Portable publication omitted a required Session owner")
    }
    for (const { ownerID, context } of input.contexts) await Owners.publish(ownerID, context)
    const published = State.parse({ ...current, phase: "activated" })
    await Storage.write(stateKey(input.handoffID), published)
  }
}
