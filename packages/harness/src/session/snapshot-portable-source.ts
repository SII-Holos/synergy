import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotRecords } from "./snapshot-records"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotLease } from "./snapshot-lease"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import type { SessionTransferOwners as Owners } from "./transfer-owners"
import type { SessionTransferStream as Stream } from "./transfer-stream"
import type { Session } from "."

export namespace SnapshotPortableSource {
  const Count = z.number().int().nonnegative().safe()
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const OID = z.string().regex(SnapshotStore.OID)
  export const Manifest = z.strictObject({
    version: z.literal(1),
    scopeID: z.string(),
    sessionID: z.string(),
    rootSessionID: z.string(),
    handoffID: z.string(),
    roots: Count,
    packs: Count,
  })
  const State = Manifest.extend({ phase: z.enum(["building", "sealed"]) })
  export const Root = z.strictObject({ version: z.literal(1), hash: OID })
  export const Pack = z.strictObject({ version: z.literal(1), ordinal: Count, bytes: Count, sha256: Hash })
  const prefix = (context: Owners.SourceContext) => ["snapshot_portable_source", context.handoffID, context.session.id]
  const stateKey = (context: Owners.SourceContext) => [...prefix(context), "state"]
  const rootsKey = (context: Owners.SourceContext) => [...prefix(context), "roots"]
  const packsKey = (context: Owners.SourceContext) => [...prefix(context), "packs"]
  const ordinal = (value: number) => String(value).padStart(16, "0")
  const dataKey = (context: Owners.SourceContext, value: number) => [...prefix(context), "bytes", ordinal(value)]
  export const historyKey = (session: Readonly<Session.Info>) => [
    "session_snapshot_history",
    session.scope.id,
    session.id,
  ]
  const manifest = (state: z.infer<typeof State>) => {
    const { phase: _phase, ...result } = state
    return Manifest.parse(result)
  }
  async function current(context: Owners.SourceContext) {
    return Storage.read(stateKey(context), { silentNotFound: true })
      .then(State.parse)
      .catch((error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      })
  }
  function same(context: Owners.SourceContext, value: z.infer<typeof Manifest>) {
    if (
      value.scopeID !== context.session.scope.id ||
      value.sessionID !== context.session.id ||
      value.rootSessionID !== context.rootSessionID ||
      value.handoffID !== context.handoffID
    )
      throw new SnapshotStore.StorageError("Snapshot capture belongs to another transfer binding")
  }
  async function* batches(context: Owners.SourceContext) {
    let batch: string[] = []
    for await (const row of Storage.records({ prefix: rootsKey(context), limit: 128 })) {
      context.signal.throwIfAborted()
      batch.push(Root.parse(row.value).hash)
      if (batch.length === 32) {
        yield batch
        batch = []
      }
    }
    if (batch.length) yield batch
  }

  export async function capture(context: Owners.SourceContext) {
    context.signal.throwIfAborted()
    using lock = await Lock.write("snapshot-portable-source:" + JSON.stringify([context.handoffID, context.session.id]))
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const previous = await current(context)
    if (previous) {
      same(context, previous)
      if (previous.phase === "sealed") return manifest(previous)
    }
    const binding = await Epochs.ownerPreparationBinding({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    if (
      binding.scopeID !== context.session.scope.id ||
      (binding.rootSessionID ?? binding.sessionID) !== context.rootSessionID
    )
      throw new SnapshotStore.StorageError("Snapshot capture has another source scope or aggregate")
    // Snapshot leases precede artifact preparation; operator checkpoints use the same lock order.
    return SnapshotLease.use(
      context.session.scope.id,
      false,
      async () => {
        await Storage.removeTree(prefix(context))
        await Storage.write(
          stateKey(context),
          State.parse({
            version: 1,
            scopeID: context.session.scope.id,
            sessionID: context.session.id,
            rootSessionID: context.rootSessionID,
            handoffID: context.handoffID,
            roots: 0,
            packs: 0,
            phase: "building",
          }),
        )
        const owner = await SnapshotStore.owner(context.session.scope.id, context.session.id)
        if (!owner || owner.backend === "deleted")
          throw new SnapshotStore.StorageError("Historical Snapshot ownership is missing")
        if (owner.backend === "shared")
          for await (const hash of SnapshotStore.roots(context.session.scope.id, context.session.id, context.signal))
            await Storage.write([...rootsKey(context), hash], Root.parse({ version: 1, hash }))
        for await (const row of Storage.records({
          kind: "part",
          scopeID: context.session.scope.id,
          sessionID: context.session.id,
          limit: 128,
        })) {
          context.signal.throwIfAborted()
          for (const hash of SnapshotRecords.partRoots(row.value))
            await Storage.write([...rootsKey(context), hash], Root.parse({ version: 1, hash }))
        }
        const operation = await SnapshotStore.resolveRepository(context.session.scope.id, context.session.id)
        const directoryRoot = path.join(Global.Path.cache, "snapshot-transfer")
        await fs.mkdir(directoryRoot, { recursive: true })
        const directory = await fs.mkdtemp(path.join(directoryRoot, "portable-source-"))
        let count = 0
        try {
          const repository = path.join(directory, "history.git")
          await SnapshotStore.initializeBareRepository(repository)
          await using catalog = await SnapshotTransfer.Catalog.create(repository, context.signal, { selective: true })
          for await (const roots of batches(context)) {
            const owned = await SnapshotStore.ownsMany(
              context.session.scope.id,
              context.session.id,
              roots,
              context.signal,
            )
            if (owned.size !== roots.length)
              throw new SnapshotStore.StorageError("Historical Snapshot roots are missing or unowned")
            await catalog.verifyTrees(operation.repository, roots, context.signal)
            await catalog.import(operation.repository, { roots, requiredTrees: roots, signal: context.signal })
          }
          const packs = path.join(repository, "objects", "pack")
          for await (const entry of await fs.opendir(packs)) {
            if (!entry.isFile() || !/^pack-[a-f0-9]{40}\.pack$/.test(entry.name)) continue
            context.signal.throwIfAborted()
            const hash = createHash("sha256")
            let bytes = 0
            using prepared = await Storage.prepareBinaryStream(
              dataKey(context, count),
              (async function* () {
                for await (const block of Bun.file(path.join(packs, entry.name)).stream()) {
                  context.signal.throwIfAborted()
                  bytes += block.length
                  hash.update(block)
                  yield block
                }
              })(),
              { signal: context.signal },
            )
            const value = Pack.parse({ version: 1, ordinal: count, bytes, sha256: hash.digest("hex") })
            await Storage.transaction(async () => {
              await Storage.publishPreparedBinary(prepared)
              await Storage.write([...packsKey(context), ordinal(count)], value)
            })
            count++
          }
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
        const value = State.parse({
          version: 1,
          scopeID: context.session.scope.id,
          sessionID: context.session.id,
          rootSessionID: context.rootSessionID,
          handoffID: context.handoffID,
          roots: await Storage.count({ prefix: rootsKey(context) }),
          packs: count,
          phase: "sealed",
        })
        if (value.roots > 0 && value.packs === 0)
          throw new SnapshotStore.StorageError("Snapshot capture produced no immutable objects")
        await Epochs.assertFrozen(context.session.id, context.handoffID)
        await Storage.write(stateKey(context), value)
        return manifest(value)
      },
      { signal: context.signal },
    )
  }

  export async function* entries(context: Owners.SourceContext): AsyncGenerator<Stream.Input> {
    context.signal.throwIfAborted()
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const state = await current(context)
    if (!state || state.phase !== "sealed")
      throw new SnapshotStore.StorageError("Snapshot source capture is not sealed")
    same(context, state)
    const record = (key: string[], value: unknown): Stream.Input => ({
      id: JSON.stringify(["session-snapshots", "record", key]),
      kind: "record",
      metadata: { key },
      content: (async function* () {
        yield new TextEncoder().encode(JSON.stringify(value))
      })(),
    })
    yield record([...historyKey(context.session), "manifest"], manifest(state))
    for await (const row of Storage.records({ prefix: rootsKey(context), limit: 128 })) {
      context.signal.throwIfAborted()
      const value = Root.parse(row.value)
      yield record([...historyKey(context.session), "roots", value.hash], value)
    }
    for await (const row of Storage.records({ prefix: packsKey(context), limit: 128 })) {
      context.signal.throwIfAborted()
      const value = Pack.parse(row.value)
      const key = [...historyKey(context.session), "packs", ordinal(value.ordinal)]
      yield record([...key, "info"], value)
      yield {
        id: JSON.stringify(["session-snapshots", "history", key]),
        kind: "history",
        metadata: { key },
        content: Storage.readBinaryStream(dataKey(context, value.ordinal), { signal: context.signal }),
      }
    }
  }

  export async function discardCancelled(binding: Epochs.Binding) {
    using lock = await Lock.write("snapshot-portable-source:" + JSON.stringify([binding.handoffID, binding.sessionID]))
    const state = await Epochs.inspect(binding)
    if (state.role !== "source" || state.phase !== "cancelled")
      throw new SnapshotStore.StorageError("Snapshot source cache cleanup requires permanent source cancellation")
    await Storage.removeTree(["snapshot_portable_source", binding.handoffID, binding.sessionID])
  }
}
