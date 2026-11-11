import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { Global } from "../global"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Lock } from "../util/lock"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotLifecycle } from "./snapshot-lifecycle"
import { SnapshotPortableSource as Source } from "./snapshot-portable-source"
import { SessionTransferCore as Core } from "./transfer-core"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import type { SessionTransferOwners as Owners } from "./transfer-owners"

export namespace SnapshotPortableTarget {
  const State = z.strictObject({
    version: z.literal(1),
    manifest: Source.Manifest,
    packageHash: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    retentionID: z.string(),
    previousOwner: SnapshotStore.Owner.nullable(),
    phase: z.enum(["preparing", "prepared", "adopted", "retired"]),
  })
  const preparedContexts = new WeakMap<
    Owners.TargetContext,
    { runtime: RuntimeContext.Instance; state: z.infer<typeof State> }
  >()
  const key = (handoffID: string, sessionID: string) => ["snapshot_portable_target", handoffID, sessionID]
  const ordinal = (value: number) => String(value).padStart(16, "0")
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const id = (context: Owners.TargetContext) =>
    "snapshot_transfer_" +
    createHash("sha256")
      .update(JSON.stringify([context.handoffID, context.session.scope.id, context.session.id]))
      .digest("hex")
  const readState = (handoffID: string, sessionID: string) => Storage.read(key(handoffID, sessionID)).then(State.parse)
  function fail(message: string): never {
    throw new SnapshotStore.StorageError(message)
  }
  async function* roots(context: Owners.TargetContext) {
    let batch: string[] = []
    const prefix = [...Source.historyKey(context.session), "roots"]
    for await (const row of context.staged.records()) {
      if (!equal(row.key.slice(0, -1), prefix)) continue
      batch.push(Source.Root.parse(row.value).hash)
      if (batch.length === 32) {
        yield batch
        batch = []
      }
    }
    if (batch.length) yield batch
  }

  export async function prepare(context: Owners.TargetContext) {
    preparedContexts.delete(context)
    if (Storage.inTransaction()) fail("Snapshot content must be prepared before activation")
    using lock = await Lock.write("snapshot-portable-target:" + JSON.stringify([context.handoffID, context.session.id]))
    const reserved = await Epochs.targetPreparation({ sessionID: context.session.id, handoffID: context.handoffID })
    if (
      reserved.binding.scopeID !== context.session.scope.id ||
      (reserved.binding.rootSessionID ?? reserved.binding.sessionID) !== context.rootSessionID
    )
      fail("Snapshot preparation belongs to another destination binding")
    const prefix = Source.historyKey(context.session)
    const header = await context.staged.record([...prefix, "manifest"])
    if (!header) fail("Portable Snapshot manifest is missing")
    const manifest = Source.Manifest.parse(header.value)
    if (
      manifest.handoffID !== context.handoffID ||
      manifest.sessionID !== context.session.id ||
      manifest.scopeID !== context.session.scope.id ||
      manifest.rootSessionID !== context.rootSessionID
    )
      fail("Portable Snapshot manifest belongs to another member")
    let rootCount = 0
    let packCount = 0
    const checksum = createHash("sha256")
    for await (const row of context.staged.records()) {
      context.signal.throwIfAborted()
      if (!equal(row.key.slice(0, prefix.length), prefix)) fail("Snapshot metadata belongs to another owner")
      checksum.update(JSON.stringify(row))
      const suffix = row.key.slice(prefix.length)
      if (suffix.length === 1 && suffix[0] === "manifest") continue
      if (suffix.length === 2 && suffix[0] === "roots") {
        if (Source.Root.parse(row.value).hash !== suffix[1]) fail("Snapshot root key changed")
        rootCount++
      } else if (suffix.length === 3 && suffix[0] === "packs" && suffix[2] === "info") {
        if (ordinal(Source.Pack.parse(row.value).ordinal) !== suffix[1]) fail("Snapshot pack key changed")
        packCount++
      } else fail("Snapshot metadata has an unrelated record")
    }
    if (rootCount !== manifest.roots || packCount !== manifest.packs || (rootCount > 0 && packCount === 0))
      fail("Snapshot manifest inventory is incomplete")
    for await (const hash of Core.stagedSnapshotRoots(context))
      if (!(await context.staged.record([...prefix, "roots", hash])))
        fail("Snapshot history omits a required core root")
    const previousOwner = await SnapshotStore.owner(context.session.scope.id, context.session.id)
    if (previousOwner && !reserved.supersedes) fail("Destination has unrelated Snapshot ownership")
    const root = path.join(Global.Path.cache, "snapshot-transfer")
    await fs.mkdir(root, { recursive: true })
    const directory = await fs.mkdtemp(path.join(root, "portable-target-"))
    try {
      const repository = path.join(directory, "history.git")
      await SnapshotStore.initializeBareRepository(repository)
      let packs = 0
      for await (const artifact of context.staged.artifacts()) {
        context.signal.throwIfAborted()
        if (
          artifact.key.length !== prefix.length + 2 ||
          !equal(artifact.key.slice(0, prefix.length), prefix) ||
          artifact.key[prefix.length] !== "packs"
        )
          fail("Snapshot binary belongs to another owner")
        const row = await context.staged.record([...artifact.key, "info"])
        if (!row) fail("Snapshot pack metadata is missing")
        const info = Source.Pack.parse(row.value)
        if (
          artifact.key.at(-1) !== ordinal(info.ordinal) ||
          info.bytes !== artifact.bytes ||
          info.sha256 !== artifact.sha256
        )
          fail("Snapshot pack metadata disagrees with its bytes")
        const file = path.join(directory, String(packs) + ".pack")
        const output = await fs.open(file, "wx", 0o600)
        const hash = createHash("sha256")
        let bytes = 0
        try {
          for await (const block of artifact.read()) {
            context.signal.throwIfAborted()
            hash.update(block)
            bytes += block.length
            await output.writeFile(block)
          }
          await output.sync()
        } finally {
          await output.close()
        }
        if (bytes !== info.bytes || hash.digest("hex") !== info.sha256) fail("Snapshot pack bytes changed")
        checksum.update(JSON.stringify([artifact.key, info.bytes, info.sha256]))
        await SnapshotGit.checked(repository, ["index-pack", "--stdin", "--strict"], {
          signal: context.signal,
          input: file,
        })
        packs++
      }
      if (packs !== manifest.packs) fail("Snapshot manifest omitted a pack")
      await SnapshotGit.checked(repository, ["fsck", "--full"], { signal: context.signal })
      const value = State.parse({
        version: 1,
        manifest,
        packageHash: reserved.manifestHash,
        digest: checksum.digest("hex"),
        retentionID: id(context),
        previousOwner: previousOwner ?? null,
        phase: "preparing",
      })
      const previous = await Storage.read(key(context.handoffID, context.session.id), { silentNotFound: true }).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        },
      )
      if (previous && (State.parse(previous).digest !== value.digest || State.parse(previous).phase === "retired"))
        fail("Snapshot preparation cannot replace a sealed or retired identity")
      await Storage.write(key(context.handoffID, context.session.id), value)
      await SnapshotLease.use(
        context.session.scope.id,
        false,
        async () => {
          const operation = await SnapshotStore.resolveRepository(context.session.scope.id, value.retentionID)
          await SnapshotStore.initialize(operation)
          await using catalog = await SnapshotTransfer.Catalog.create(operation.repository, context.signal, {
            selective: true,
          })
          for await (const batch of roots(context)) {
            await catalog.verifyTrees(repository, batch, context.signal)
            const imported = await catalog.import(repository, {
              roots: batch,
              requiredTrees: batch,
              signal: context.signal,
            })
            await catalog.protect(value.retentionID, batch, context.signal, { packReferences: true })
            await SnapshotStore.retainMany(context.session.scope.id, value.retentionID, batch, context.signal)
            await catalog.releaseKeep(imported.keep)
            if (
              (await SnapshotStore.ownsMany(context.session.scope.id, value.retentionID, batch, context.signal))
                .size !== batch.length
            )
              fail("Prepared private Snapshot history is unreadable")
          }
        },
        { signal: context.signal },
      )
      value.phase = "prepared"
      await Storage.transaction(async () => {
        const latest = await Epochs.targetPreparation({ sessionID: context.session.id, handoffID: context.handoffID })
        if (latest.manifestHash !== value.packageHash) fail("Snapshot destination package changed during preparation")
        await Storage.write(key(context.handoffID, context.session.id), value)
      })
      preparedContexts.set(context, { runtime: RuntimeContext.current(), state: value })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  export function prepared(context: Owners.TargetContext) {
    const proof = preparedContexts.get(context)
    if (!proof || proof.runtime !== RuntimeContext.current())
      fail("Snapshot publication requires an exact prepared context")
    return { digest: proof.state.digest }
  }

  export async function publish(context: Owners.TargetContext) {
    Epochs.assertActivation({ sessionID: context.session.id, handoffID: context.handoffID })
    const proof = prepared(context)
    const state = await readState(context.handoffID, context.session.id)
    if (state.phase !== "prepared" || state.digest !== proof.digest) fail("Snapshot prepared identity changed")
    const previous = await SnapshotStore.owner(context.session.scope.id, context.session.id)
    if (!equal(previous ?? null, state.previousOwner)) fail("Snapshot ownership changed before publication")
    const retained = await SnapshotStore.owner(context.session.scope.id, state.retentionID)
    if (!retained || retained.backend !== "shared" || retained.retentionID !== state.retentionID)
      fail("Snapshot private retention owner changed")
    await SnapshotStore.write(StoragePath.snapshotOwner(context.session.scope.id, context.session.id), {
      version: 3,
      backend: "shared",
      retentionID: state.retentionID,
    })
    await Storage.remove(StoragePath.snapshotOwner(context.session.scope.id, state.retentionID))
    await Storage.write(key(context.handoffID, context.session.id), { ...state, phase: "adopted" })
  }

  export async function retire(binding: Epochs.Binding) {
    using lock = await Lock.write("snapshot-portable-target:" + JSON.stringify([binding.handoffID, binding.sessionID]))
    const proof = await Epochs.inspect(binding)
    if (proof.role !== "target" || proof.phase !== "never_activate")
      fail("Snapshot cleanup requires permanent destination retirement")
    const state = await readState(binding.handoffID, binding.sessionID).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (!state) return
    if (state.packageHash !== proof.manifestHash || state.phase === "adopted")
      fail("Snapshot retirement cannot release adopted history")
    if (state.phase === "retired") return
    await SnapshotLifecycle.beginDelete(binding.scopeID, state.retentionID)
    await SnapshotStore.releaseContent(binding.scopeID, state.retentionID)
    await SnapshotLifecycle.completeDelete(binding.scopeID, state.retentionID)
    await Storage.write(key(binding.handoffID, binding.sessionID), { ...state, phase: "retired" })
  }
}
