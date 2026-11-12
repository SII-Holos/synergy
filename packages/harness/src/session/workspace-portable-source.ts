import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspacePortableTree } from "../workspace/portable-tree"
import { Session } from "."
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionTransferSource as Source } from "./transfer-source"
import { SessionTransferCore as Core } from "./transfer-core"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferStream as Stream } from "./transfer-stream"
import type { BlobStore } from "../storage/blobs"
import { withStorageQueueOptions } from "../storage/queue"
import { WorkspacePortableSchema as Schema } from "./workspace-portable-schema"
import { Global } from "../global"
import { initializeSqliteEngine } from "../storage/sqlite-engine"

export namespace WorkspacePortableSource {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Reference = Schema.Reference
  const Frame = Schema.Frame
  const Captured = Schema.Captured
  const Closed = z.strictObject({ version: z.literal(1), hash: Hash })
  export const Receipt = Schema.Receipt
  export type Receipt = z.infer<typeof Receipt>
  export interface SourcePort {
    assert(): void
    capture(
      workspace: Readonly<WorkspaceCatalog.Info>,
      store: BlobStore,
      signal: AbortSignal,
    ): Promise<WorkspacePortableTree.Root>
  }
  export interface Host {
    source(binding: Epochs.Binding): SourcePort
  }
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))
  interface Proof {
    binding: Epochs.Binding
    hash: string
    assert(): void
    verified?: Promise<void>
  }
  const proofs = Storage.state(() => new Map<string, Proof>())
  const prefix = (binding: Epochs.Binding) => ["session_workspace_capture", binding.handoffID, binding.sessionID]
  const member = (binding: Epochs.Binding, sessionID: string) => [...prefix(binding), "members", sessionID]
  const workspace = (binding: Epochs.Binding, workspaceID: string) => [
    ...prefix(binding),
    "workspaces",
    Schema.workspaceSegment(binding.scopeID, workspaceID),
  ]
  const reference = (binding: Epochs.Binding, sessionID: string, workspaceID: string) => [
    ...member(binding, sessionID),
    "refs",
    Schema.workspaceSegment(binding.scopeID, workspaceID),
  ]
  const proofKey = (binding: Pick<Epochs.Binding, "handoffID" | "sessionID">) =>
    JSON.stringify([binding.handoffID, binding.sessionID])
  const receiptKey = (binding: Epochs.Binding) => [...prefix(binding), "receipt"]
  const closedKey = (binding: Epochs.Binding) => [...prefix(binding), "closed"]
  const same = (a: Epochs.Binding, b: Epochs.Binding) =>
    Object.keys(Epochs.Binding.shape).every(
      (field) => a[field as keyof Epochs.Binding] === b[field as keyof Epochs.Binding],
    )
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  export function registerHost(host: Host) {
    RuntimeContext.assertCompositionOpen("Workspace portability Host")
    if (state().host) fail("Workspace portability Host is already registered")
    state().host = Object.freeze({ source: host.source.bind(host) })
  }
  export function applies(_session: Readonly<Session.Info>) {
    return true
  }
  function contextOwner(input: Owners.SourceContext) {
    const signal = input.signal
    signal.throwIfAborted()
    const session = Object.freeze(structuredClone(input.session))
    Epochs.Binding.shape.sessionID.parse(session.id)
    Epochs.Binding.shape.scopeID.parse(session.scope.id)
    const context = Object.freeze({
      session,
      rootSessionID: Epochs.Binding.shape.sessionID.parse(input.rootSessionID),
      handoffID: Epochs.Binding.shape.handoffID.parse(input.handoffID),
      signal,
    })
    const runtime = RuntimeContext.current()
    const selected = Storage.current()
    const objects = selected.artifactObjects
    const storage = {
      store: selected.store,
      directory: selected.artifactDirectory,
      objects,
      blobs: objects?.blobs,
      writerID: objects?.writerID,
      now: objects?.now,
    }
    const guard = () => {
      signal.throwIfAborted()
      if (RuntimeContext.current() !== runtime) fail("Workspace context belongs to another Runtime or storage owner")
      const current = Storage.current()
      if (
        current.store !== storage.store ||
        current.artifactDirectory !== storage.directory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== storage.blobs ||
        objects?.writerID !== storage.writerID ||
        objects?.now !== storage.now
      )
        fail("Workspace context belongs to another Runtime or storage owner")
    }
    guard()
    return { context, guard }
  }
  export async function inspect(context: Owners.SourceContext): Promise<Owners.Inspection> {
    const owned = contextOwner(context)
    const { session } = owned.context
    const requirements: Owners.Requirement[] = []
    if (!state().host)
      requirements.push({
        owner: "session-workspaces",
        code: "workspace_native_owner_missing",
        label: "Install the native Workspace capture owner",
        recoverable: true,
      })
    if (session.workspaceID) {
      const current = await WorkspaceCatalog.get(session.workspaceID, session.scope.id)
      owned.guard()
      if (current.backend?.provider === "objects" || current.activeMount || current.sharedWritableWorkspaceIDs.length)
        requirements.push({
          owner: "session-workspaces",
          code: "workspace_native_mapping_required",
          label: "Select a supported native working location and explicit writable mappings",
          recoverable: true,
        })
    }
    owned.guard()
    return { requirements, children: (async function* () {})() }
  }
  export async function freeze(context: Owners.SourceContext) {
    const owned = contextOwner(context)
    const result = await inspect(owned.context)
    owned.guard()
    if (result.requirements.length)
      throw new Owners.Rejected({
        message: "Workspace capture requires its native owner",
        requirements: result.requirements,
      })
  }
  export function exportEntries(value: Owners.SourceContext): AsyncIterable<Stream.Input> {
    const owned = contextOwner(value)
    const context = owned.context
    const key = proofKey({ handoffID: context.handoffID, sessionID: context.rootSessionID })
    const proof = proofs().get(key)
    function guard() {
      owned.guard()
      if (!proof || proofs().get(key) !== proof) fail("Workspace export requires its completed native file capture")
      proof.assert()
    }
    function record(row: Schema.Row): Stream.Input {
      const key = Schema.key(context.session, row)
      return {
        id: "workspace-record:" + createHash("sha256").update(JSON.stringify(key)).digest("hex"),
        kind: "record",
        metadata: { key, transferOwner: "session-workspaces", transferSessionID: context.session.id },
        content: (async function* () {
          guard()
          yield new TextEncoder().encode(JSON.stringify(row.value))
          guard()
        })(),
      }
    }
    return (async function* () {
      guard()
      if (!proof) fail("Workspace export requires its completed native file capture")
      const binding = proof.binding
      if (
        binding.sessionID !== context.rootSessionID ||
        binding.handoffID !== context.handoffID ||
        binding.scopeID !== context.session.scope.id
      )
        fail("Workspace export belongs to another source binding")
      const epoch = await Epochs.inspect(binding)
      guard()
      if (epoch.role !== "source" || !same(epoch.binding, binding) || !["frozen", "surrendered"].includes(epoch.phase))
        fail("Workspace export requires its frozen native source")
      const retained = await receipt(binding)
      guard()
      if (!retained || retained.hash !== proof.hash) fail("Workspace immutable capture receipt changed")
      if (!proof.verified) {
        const checking: Promise<void> = Promise.resolve()
          .then(async () => {
            guard()
            const current = await inventory(binding, guard, (rows) => Schema.digest(binding, rows(), context.signal))
            guard()
            if (JSON.stringify(current) !== JSON.stringify(retained))
              fail("Workspace immutable capture closure changed")
            await Storage.transaction(
              async () => {
                guard()
                const current = await Epochs.inspect(binding)
                if (current.role !== "source" || !["frozen", "surrendered"].includes(current.phase))
                  fail("Workspace closure requires its final frozen source")
                await Storage.write(closedKey(binding), Closed.parse({ version: 1, hash: proof.hash }))
              },
              { commitGuard: guard },
            )
          })
          .catch((error) => {
            if (proof.verified === checking) proof.verified = undefined
            throw error
          })
        proof.verified = checking
      }
      await proof.verified
      guard()
      const memberInfo = Schema.Member.parse(await Storage.read([...member(binding, context.session.id), "identity"]))
      guard()
      if (
        memberInfo.sessionID !== context.session.id ||
        memberInfo.scopeID !== context.session.scope.id ||
        memberInfo.current !== (context.session.workspaceID ?? null)
      )
        fail("Workspace export member identity changed")
      yield record({ kind: "member", value: memberInfo })
      for await (const row of records([...member(binding, context.session.id), "refs"], guard)) {
        const reference = Reference.parse(row.value)
        if (
          reference.scopeID !== binding.scopeID ||
          row.key.at(-1) !== Schema.workspaceSegment(reference.scopeID, reference.id)
        )
          fail("Workspace export reference identity changed")
        yield record({ kind: "reference", sessionID: context.session.id, value: reference })
      }
      if (!memberInfo.current) return
      const root = workspace(binding, memberInfo.current)
      const captured = Captured.parse(await Storage.read([...root, "tree"]))
      guard()
      if (captured.workspaceID !== memberInfo.current || captured.scopeID !== memberInfo.scopeID)
        fail("Workspace export tree belongs to another member")
      yield record({ kind: "workspace", value: captured })
      for await (const row of records([...root, "objects"], guard)) {
        const frame = Frame.parse(row.value)
        if (row.key.at(-1) !== frame.hash) fail("Workspace export frame index changed")
        yield record({ kind: "frame", workspaceID: captured.workspaceID, scopeID: captured.scopeID, value: frame })
        const key = Schema.artifactKey(context.session, captured.workspaceID, frame.hash)
        yield {
          id: "workspace-bytes:" + createHash("sha256").update(JSON.stringify(key)).digest("hex"),
          kind: "artifact",
          metadata: { key, transferOwner: "session-workspaces", transferSessionID: context.session.id },
          content: (async function* () {
            guard()
            const reader = Storage.readBinaryStream([...root, "bytes", frame.hash], { signal: context.signal })
            const hash = createHash("sha256")
            let bytes = 0
            try {
              for (;;) {
                guard()
                const next = await reader.next()
                guard()
                if (next.done) break
                bytes += next.value.byteLength
                if (bytes > frame.bytes) fail("Workspace export frame exceeds its immutable size")
                hash.update(next.value)
                yield next.value
              }
              if (bytes !== frame.bytes || hash.digest("hex") !== frame.hash)
                fail("Workspace export frame checksum mismatch")
            } finally {
              await reader.return(undefined)
            }
          })(),
        }
      }
      guard()
    })()
  }
  async function* records(prefix: string[], guard: () => void) {
    const iterator = Storage.records({ prefix, limit: 128 })
    try {
      for (;;) {
        guard()
        const next = await iterator.next()
        guard()
        if (next.done) return
        yield next.value
      }
    } finally {
      await iterator.return(undefined)
    }
  }
  async function inventory<T>(
    binding: Epochs.Binding,
    guard: () => void,
    body: (rows: () => AsyncGenerator<Schema.Row>) => Promise<T>,
  ) {
    guard()
    const cache = Global.Path.cache
    await initializeSqliteEngine()
    guard()
    await fs.mkdir(cache, { recursive: true })
    guard()
    const directory = await fs.mkdtemp(path.join(cache, "workspace-closure-"))
    const database = new Database(path.join(directory, "inventory.sqlite"))
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE metadata(position TEXT PRIMARY KEY,body TEXT NOT NULL) WITHOUT ROWID",
      )
      using add = database.prepare("INSERT INTO metadata(position,body) VALUES(?,?)")
      const insert = (row: Schema.Row) => add.run(Schema.order(row), JSON.stringify(Schema.Row.parse(row)))
      const base = prefix(binding).length
      for await (const row of records([...prefix(binding), "members"], guard)) {
        const suffix = row.key.slice(base)
        const sessionID = z.string().min(1).parse(suffix[1])
        if (suffix.length === 3 && suffix[2] === "identity") {
          const value = Schema.Member.parse(row.value)
          if (value.sessionID !== sessionID) fail("Workspace member index changed")
          insert({ kind: "member", value })
        } else if (suffix.length === 4 && suffix[2] === "refs") {
          const value = Reference.parse(row.value)
          if (Schema.workspaceSegment(value.scopeID, value.id) !== suffix[3]) fail("Workspace reference index changed")
          insert({ kind: "reference", sessionID, value })
        } else fail("Workspace member capture contains an unknown record")
      }
      let selected: { segment: string; value: Schema.Captured } | undefined
      for await (const row of records([...prefix(binding), "workspaces"], guard)) {
        const suffix = row.key.slice(base)
        const segment = z.string().min(1).parse(suffix[1])
        if (selected?.segment !== segment) {
          const value = Captured.parse(await Storage.read([...prefix(binding), "workspaces", segment, "tree"]))
          guard()
          if (Schema.workspaceSegment(value.scopeID, value.workspaceID) !== segment)
            fail("Workspace tree index changed")
          selected = { segment, value }
        }
        if (suffix.length === 3 && suffix[2] === "tree") insert({ kind: "workspace", value: Captured.parse(row.value) })
        else if (suffix.length === 4 && suffix[2] === "objects")
          insert({
            kind: "frame",
            scopeID: selected.value.scopeID,
            workspaceID: selected.value.workspaceID,
            value: Frame.parse(row.value),
          })
        else if (suffix[2] !== "frames") fail("Workspace tree capture contains an unknown record")
      }
      const rows = async function* () {
        using page = database.prepare<{ position: string; body: string }, [string]>(
          "SELECT position,body FROM metadata WHERE position>? ORDER BY position COLLATE BINARY LIMIT 128",
        )
        let after = ""
        for (;;) {
          guard()
          const values = page.all(after)
          if (!values.length) return
          for (const value of values) {
            guard()
            yield Schema.Row.parse(JSON.parse(value.body))
          }
          after = values.at(-1)!.position
        }
      }
      return await body(rows)
    } finally {
      database.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  export async function receipt(value: Epochs.Binding): Promise<Receipt | undefined> {
    const binding = Epochs.Binding.parse(value)
    const [raw] = await Storage.readMany([receiptKey(binding)])
    if (raw === undefined) return
    const retained = Receipt.parse(raw)
    if (!same(retained.binding, binding)) fail("Workspace capture belongs to another source binding")
    return retained
  }
  export function capture(input: { binding: Epochs.Binding; signal: AbortSignal }): Promise<Receipt> {
    const binding = Object.freeze(Epochs.Binding.parse(input.binding))
    const signal = input.signal
    return withStorageQueueOptions({ signal }, () => captureSource(binding, signal))
  }
  async function captureSource(binding: Epochs.Binding, signal: AbortSignal): Promise<Receipt> {
    if (binding.rootSessionID && binding.rootSessionID !== binding.sessionID)
      fail("Workspace capture requires its aggregate root")
    if (Storage.inTransaction()) fail("Native Workspace capture must run outside a SQL transaction")
    const host = state().host
    if (!host) fail("This Runtime has no native Workspace capture owner")
    const port = host.source(binding)
    const assertNative = port.assert.bind(port)
    const captureNative = port.capture.bind(port)
    const runtime = RuntimeContext.current()
    const selected = Storage.current()
    const storage = {
      store: selected.store,
      artifactDirectory: selected.artifactDirectory,
      artifactObjects: selected.artifactObjects,
      blobs: selected.artifactObjects?.blobs,
      writerID: selected.artifactObjects?.writerID,
      now: selected.artifactObjects?.now,
    }
    function guard() {
      signal.throwIfAborted()
      assertNative()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== storage.store ||
        current.artifactDirectory !== storage.artifactDirectory ||
        current.artifactObjects !== storage.artifactObjects ||
        current.artifactObjects?.blobs !== storage.blobs ||
        current.artifactObjects?.writerID !== storage.writerID ||
        current.artifactObjects?.now !== storage.now
      )
        fail("Workspace capture belongs to another Runtime or storage owner")
    }
    guard()
    using lock = await Lock.writeWithSignal("session-workspace-capture:" + binding.sessionID, signal)
    guard()
    if (!lock) fail("Workspace capture could not acquire its native operation lock")
    const epoch = await Epochs.inspect(binding)
    guard()
    if (epoch.role !== "source" || !same(epoch.binding, binding))
      fail("Workspace capture requires its exact source epoch")
    const retained = await receipt(binding)
    guard()
    if (epoch.phase === "frozen") {
      if (!retained) fail("Frozen source has no immutable Workspace capture")
      const [closed] = await Storage.readMany([closedKey(binding)])
      guard()
      if (closed === undefined || Closed.parse(closed).hash !== retained.hash)
        fail("Frozen source has no completed immutable Workspace closure; cancel this incomplete intent")
      proofs().set(proofKey(binding), { binding, hash: retained.hash, assert: guard })
      return retained
    }
    if (epoch.phase !== "draining") fail("Workspace capture requires a draining source")
    proofs().delete(proofKey(binding))
    await Storage.removeTree(prefix(binding))
    guard()
    let foundRoot = false
    for await (const entry of Source.members(binding, signal)) {
      guard()
      const session = await Session.get(entry.binding.sessionID)
      guard()
      if (session.scope.id !== binding.scopeID) fail("Workspace cohort crosses its canonical Scope")
      foundRoot ||= session.id === binding.sessionID
      await Storage.write([...member(binding, session.id), "identity"], {
        version: 1,
        sessionID: session.id,
        scopeID: session.scope.id,
        current: session.workspaceID ?? null,
      })
      for await (const found of Core.workspaceReferences(session, signal)) {
        guard()
        if (found.scopeID !== binding.scopeID) fail("Historical Workspace reference crosses its canonical Scope")
        const key = reference(binding, session.id, found.id)
        const [old] = await Storage.readMany([key])
        const previous = old === undefined ? undefined : Reference.parse(old)
        const generation = Math.max(previous?.generation ?? 0, found.generation ?? 0)
        const next = Reference.parse({
          version: 1,
          id: found.id,
          scopeID: found.scopeID,
          current: found.id === session.workspaceID,
          ...(generation ? { generation } : {}),
        })
        await Storage.write(key, next)
      }
      if (session.workspaceID) {
        const current = await WorkspaceCatalog.get(session.workspaceID, binding.scopeID)
        guard()
        await Storage.write(
          reference(binding, session.id, current.id),
          Reference.parse({
            version: 1,
            id: current.id,
            scopeID: current.scopeID,
            current: true,
            generation: current.binding.generation,
          }),
        )
        const key = [...workspace(binding, current.id), "tree"]
        const [old] = await Storage.readMany([key])
        guard()
        if (old !== undefined) {
          const previous = Captured.parse(old)
          if (
            previous.workspaceID !== current.id ||
            previous.scopeID !== binding.scopeID ||
            previous.generation !== current.binding.generation
          )
            fail("Shared Workspace generation changed during capture")
        } else {
          const root = workspace(binding, current.id)
          let indexing = false
          const store: BlobStore = {
            async put(hash, bytes) {
              guard()
              Frame.parse({ version: 1, hash, bytes: bytes.byteLength })
              if (createHash("sha256").update(bytes).digest("hex") !== hash)
                fail("Workspace frame checksum disagrees with its bytes")
              const info = [...root, "frames", hash]
              const [old] = await Storage.readMany([info])
              guard()
              if (old !== undefined) {
                const previous = Frame.parse(old)
                if (previous.hash !== hash || previous.bytes !== bytes.byteLength)
                  fail("Workspace immutable frame changed")
                return
              }
              using prepared = await Storage.prepareBinary([...root, "bytes", hash], bytes)
              guard()
              await Storage.transaction(
                async () => {
                  guard()
                  await Storage.publishPreparedBinary(prepared)
                  await Storage.write(info, Frame.parse({ version: 1, hash, bytes: bytes.byteLength }))
                },
                { commitGuard: guard },
              )
            },
            async get(hash, maximumBytes) {
              guard()
              const frame = Frame.parse(await Storage.read([...root, "frames", Hash.parse(hash)]))
              guard()
              if (frame.hash !== hash) fail("Workspace retained frame has another identity")
              if (frame.bytes > maximumBytes) fail("Workspace frame exceeds its requested bound")
              const bytes = await Storage.readBinary([...root, "bytes", hash], { maxBytes: maximumBytes })
              guard()
              if (bytes.byteLength !== frame.bytes || createHash("sha256").update(bytes).digest("hex") !== hash)
                fail("Workspace retained frame checksum mismatch")
              if (indexing) {
                const key = [...root, "objects", hash]
                const [existing] = await Storage.readMany([key])
                guard()
                if (existing === undefined)
                  await Storage.transaction(
                    async () => {
                      guard()
                      await Storage.write(key, frame)
                    },
                    { commitGuard: guard },
                  )
                else if (JSON.stringify(Frame.parse(existing)) !== JSON.stringify(frame))
                  fail("Reachable Workspace frame changed")
              }
              return bytes
            },
          }
          const files = WorkspacePortableTree.Root.parse(
            await captureNative(Object.freeze(structuredClone(current)), store, signal),
          )
          guard()
          const directory = Global.Path.cache
          await fs.mkdir(directory, { recursive: true })
          guard()
          indexing = true
          try {
            await using reader = await Stream.open({ root: files.tree, store, directory, signal })
            for await (const entry of reader.entries()) {
              guard()
              const metadata = WorkspacePortableTree.Metadata.parse(entry.metadata)
              WorkspacePortableTree.path(entry.id, metadata)
              if (
                entry.kind !== (metadata.kind === "file" ? "file" : "record") ||
                (metadata.kind !== "file" && entry.bytes)
              )
                fail("Workspace files have incompatible native metadata")
              for await (const _chunk of entry.content) guard()
            }
            if (!reader.verified()) fail("Workspace files did not verify their complete native graph")
          } finally {
            indexing = false
          }
          guard()
          await Storage.write(
            key,
            Captured.parse({
              version: 1,
              workspaceID: current.id,
              scopeID: binding.scopeID,
              generation: current.binding.generation,
              files,
            }),
          )
        }
      }
    }
    guard()
    if (!foundRoot) fail("Workspace capture omits its canonical root")
    const captured = await inventory(binding, guard, (rows) => Schema.digest(binding, rows(), signal))
    await Storage.transaction(
      async () => {
        guard()
        await Storage.write(receiptKey(binding), captured)
      },
      { commitGuard: guard },
    )
    guard()
    proofs().set(proofKey(binding), { binding, hash: captured.hash, assert: guard })
    return captured
  }
}
