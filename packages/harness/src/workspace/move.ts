import { createHash } from "node:crypto"
import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceContent, type BlobStore } from "./content"
import { WorkspaceArchive } from "./archive"
import { WorkspacePortableTree as Portable } from "./portable-tree"
import { WorkspaceTree } from "./tree"

export namespace WorkspaceMove {
  const ID = z.string().min(1).max(128)
  const Selection = z.strictObject({ workspaceID: ID, scopeID: ID, generation: z.number().int().positive().safe() })
  export const Request = z.strictObject({
    id: ID,
    source: Selection,
    target: Selection.extend({ path: WorkspaceTree.Path, expectedRevision: z.number().int().positive().safe() }),
    mappingRevision: z.number().int().positive().safe(),
    acceptedDiffHash: z.null(),
    actor: ActorStamp.Info,
  })
  export type Request = z.infer<typeof Request>
  export const Rejected = NamedError.create("WorkspaceMoveRejected", z.object({ message: z.string(), moveID: ID }))
  const Content = z.strictObject({
    revision: z.number().int().nonnegative().safe(),
    manifest: WorkspaceTree.Hash.nullable(),
  })
  export const Receipt = z.strictObject({
    version: z.literal(1),
    id: ID,
    requestHash: WorkspaceTree.Hash,
    mappingRevision: z.number().int().positive().safe(),
    acceptedDiffHash: z.null(),
    source: Selection.extend({ hostID: ID, physicalID: z.string().min(1), manifest: WorkspaceTree.Hash }),
    target: Selection.extend({
      path: WorkspaceTree.Path,
      before: Content,
      after: Content,
      revision: z.number().int().positive().safe(),
      mount: z.null(),
      mountGeneration: z.number().int().nonnegative().safe(),
    }),
    subtreeHash: WorkspaceTree.Hash,
    publishedAt: z.number().int().nonnegative().safe(),
  })
  export type Receipt = z.infer<typeof Receipt>
  const Record = z.strictObject({
    version: z.literal(1),
    digest: WorkspaceTree.Hash,
    request: Request,
    state: z.enum(["preparing", "publishing", "published", "activated", "cancelled", "retired"]),
    nativeRequested: z.boolean().default(false),
    native: JsonValue.optional(),
    candidate: WorkspaceTree.Hash.optional(),
    receipt: Receipt.optional(),
  })
  type Record = z.infer<typeof Record>
  export const Status = Record.omit({ native: true })
  export interface SourceLease {
    readonly reference: z.infer<typeof JsonValue>
    capture<T>(
      store: BlobStore,
      consume: (info: WorkspaceCatalog.Info, root: Portable.Root, assertCurrent: () => void) => Promise<T>,
    ): Promise<T>
  }
  export interface SourceHost {
    hold(
      source: Request["source"],
      id: string,
      previous: z.infer<typeof JsonValue> | undefined,
      signal?: AbortSignal,
    ): Promise<SourceLease>
    release(source: Request["source"], id: string, reference: z.infer<typeof JsonValue> | undefined): Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    host: undefined as SourceHost | undefined,
    jobs: new Map<string, { digest: string; promise: Promise<Receipt>; assertOwner(): void }>(),
  }))
  const running = RuntimeContext.createAsyncContext<() => void>()
  const publication = RuntimeContext.createAsyncContext<{
    request: Request
    digest: string
    open: boolean
    assert(): void
  }>()
  const key = (request: Request) => ["workspace_move", request.target.scopeID, request.id]
  const active = (scopeID: string, workspaceID: string) => ["workspace_move_active", scopeID, workspaceID]
  const indexKey = (request: Request) => [...active(request.target.scopeID, request.target.workspaceID), request.id]
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  export function receiptHash(value: Receipt) {
    return hash(Receipt.parse(value))
  }
  const nativeID = (request: Request) =>
    "workspace-move:" +
    hash([
      request,
      RuntimeContext.current().host.root,
      Storage.current().store.options,
      Storage.current().artifactDirectory,
    ])
  const contains = (parent: string, child: string) => !parent || child === parent || child.startsWith(parent + "/")
  const overlaps = (left: string, right: string) => contains(left, right) || contains(right, left)
  const held = (record: Record) => ["preparing", "publishing", "published"].includes(record.state)
  function reject(request: Request, message: string): never {
    throw new Rejected({ moveID: request.id, message })
  }
  function host() {
    const selected = state().host
    if (!selected) throw new Error("Native Workspace move source Host is unavailable")
    return selected
  }
  export function registerSourceHost(value: SourceHost) {
    RuntimeContext.assertCompositionOpen("Workspace move source")
    if (state().host) throw new Error("Workspace move source Host is already registered")
    state().host = Object.freeze({ hold: value.hold.bind(value), release: value.release.bind(value) })
  }
  export function register() {
    RuntimeMaintenance.register("workspace-moves", {
      version: 1,
      order: 224,
      async suspend(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
      },
      async drain(context) {
        await RuntimeMaintenance.assertDraining(context.lease)
      },
      async inspect(context) {
        for await (const row of Storage.records({ prefix: ["workspace_move"], limit: 128 })) {
          context.signal.throwIfAborted()
          const record = Record.parse(row.value)
          if (held(record) || record.nativeRequested || record.native !== undefined)
            return [
              {
                owner: "workspace-moves",
                code: "workspace_move_unsettled",
                label: "Reconcile the original Workspace move receipt and retained native claim",
                recoverable: true,
              },
            ]
        }
        return []
      },
      async release(context) {
        await RuntimeMaintenance.assertReleasing(context.lease)
      },
    })
  }
  async function read(request: Request): Promise<Record | undefined> {
    const [raw] = await Storage.readMany([key(request)])
    if (raw === undefined) return
    const record = Record.parse(raw)
    if (record.digest !== hash(request) || JSON.stringify(record.request) !== JSON.stringify(request))
      reject(request, "Workspace move identity already has different input")
    return record
  }
  async function* reservations(info: Pick<WorkspaceCatalog.Info, "id" | "scopeID">) {
    for await (const row of Storage.records({ prefix: active(info.scopeID, info.id), limit: 128 })) {
      const request = Request.parse(row.value)
      if (
        request.target.workspaceID !== info.id ||
        request.target.scopeID !== info.scopeID ||
        JSON.stringify(row.key) !== JSON.stringify(indexKey(request))
      )
        reject(request, "Workspace move reservation has another canonical target")
      const record = await read(request)
      if (!record || !held(record)) reject(request, "Workspace move reservation has no retained owner")
      yield record
    }
  }
  export async function assertMutation(info: Pick<WorkspaceCatalog.Info, "id" | "scopeID">, paths: readonly string[]) {
    const permit = publication.getStore()
    for await (const record of reservations(info)) {
      const target = record.request.target.path
      if (!paths.some((name) => overlaps(name, target))) continue
      if (
        permit?.open &&
        permit.digest === record.digest &&
        permit.request.id === record.request.id &&
        paths.every((name) => contains(target, name))
      ) {
        permit.assert()
        continue
      }
      reject(record.request, "Workspace range is reserved by its original move")
    }
  }
  export async function assertLifecycle(info: Pick<WorkspaceCatalog.Info, "id" | "scopeID">) {
    for await (const record of reservations(info))
      reject(record.request, "Workspace lifecycle is reserved by its original move")
  }
  async function prepare(request: Request) {
    return Storage.transaction(async () => {
      const existing = await read(request)
      if (existing) return existing
      await RuntimeMaintenance.assertAdmission()
      const info = await WorkspaceCatalog.get(request.target.workspaceID, request.target.scopeID)
      if (
        info.backend?.provider !== "objects" ||
        info.lifecycle !== "active" ||
        info.binding.state !== "bound" ||
        info.activeMount
      )
        reject(request, "Workspace move requires a dormant object target without an active mount")
      if (info.binding.generation !== request.target.generation || info.revision !== request.target.expectedRevision)
        reject(request, "Workspace move target version changed")
      await assertMutation(info, [request.target.path])
      const record = Record.parse({ version: 1, request, digest: hash(request), state: "preparing" })
      await Storage.write(key(request), record)
      await Storage.write(indexKey(request), request)
      return record
    })
  }
  async function releaseNative(request: Request) {
    const assert = WorkspaceContent.captureOwner()
    const id = nativeID(request)
    const record = await read(request)
    assert()
    if (!record || (!record.nativeRequested && record.native === undefined)) return
    await host().release(request.source, id, record.native)
    assert()
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || JSON.stringify(current.native) !== JSON.stringify(record.native))
          reject(request, "Workspace move source claim changed")
        await Storage.write(key(request), Record.parse({ ...current, nativeRequested: false, native: undefined }))
      },
      { commitGuard: assert },
    )
  }
  export async function inspect(value: Request) {
    const request = Request.parse(value)
    const assert = WorkspaceContent.captureOwner()
    const record = await Storage.snapshot(() => read(request))
    assert()
    if (!record) return
    const { native: _, ...status } = record
    return Status.parse(status)
  }
  async function subtree(info: WorkspaceCatalog.Info, store: BlobStore, root: string) {
    return WorkspaceContent.withTree(info, store, async (tree) => {
      const entry = await tree.get(root)
      if (entry?.kind !== "directory") throw new Error("Published Workspace move directory is absent")
      const digest = createHash("sha256").update(JSON.stringify({ mode: entry.mode }))
      for await (const header of tree.entries({ prefix: root + "/" })) {
        digest.update(JSON.stringify({ ...header, path: header.path.slice(root.length + 1) }))
        if (header.kind === "file") for await (const _ of tree.read(header.path)) tree.assertCurrent()
      }
      return digest.digest("hex")
    })
  }
  export async function validate(value: Request) {
    const request = Request.parse(value)
    const assert = WorkspaceContent.captureOwner()
    const record = await read(request)
    assert()
    if (!record?.receipt || !held(record)) reject(request, "Workspace move has no retained published receipt")
    const { info, store } = await WorkspaceContent.resolve(request.target)
    assert()
    if ((info.mountGeneration ?? 0) !== record.receipt.target.mountGeneration)
      reject(request, "Workspace move native mount generation changed")
    if ((await subtree(info, store, request.target.path)) !== record.receipt.subtreeHash)
      reject(request, "Workspace move directory no longer matches its original receipt")
    assert()
    return Receipt.parse(record.receipt)
  }
  export async function run(value: Request, options: { signal?: AbortSignal } = {}): Promise<Receipt> {
    const request = Request.parse(value)
    const signal = options.signal
    const assert = WorkspaceContent.captureOwner(signal)
    assert()
    const jobKey = JSON.stringify(key(request))
    const digest = hash(request)
    const existing = state().jobs.get(jobKey)
    if (existing) {
      existing.assertOwner()
      if (existing.digest !== digest) reject(request, "Workspace move identity already has different input")
      return existing.promise
    }
    const assertOwner = WorkspaceContent.captureOwner()
    const promise = running.run(assertOwner, () => execute(request, signal, assert))
    state().jobs.set(jobKey, { digest, promise, assertOwner })
    try {
      return await promise
    } finally {
      state().jobs.delete(jobKey)
    }
  }
  async function execute(request: Request, signal: AbortSignal | undefined, assert: () => void): Promise<Receipt> {
    host()
    const record = await prepare(request)
    assert()
    if (record.receipt) {
      await releaseNative(request)
      assert()
      return Receipt.parse(record.receipt)
    }
    if (record.state === "publishing")
      reject(request, "Workspace move publication is unresolved; inspect the original moveID")
    if (!held(record)) reject(request, "Workspace move was permanently cancelled or retired")
    const selected = await WorkspaceContent.resolve(request.target)
    assert()
    const get = selected.store.get.bind(selected.store),
      put = selected.store.put.bind(selected.store)
    const store: BlobStore = {
      async get(hash, maximum) {
        assert()
        const bytes = await get(hash, maximum)
        assert()
        return bytes
      },
      async put(hash, bytes) {
        assert()
        await put(hash, bytes)
        assert()
      },
    }
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Workspace move no longer owns its target reservation")
        await Storage.write(key(request), Record.parse({ ...current, nativeRequested: true }))
      },
      { commitGuard: assert },
    )
    const source = await host().hold(request.source, nativeID(request), record.native, signal)
    const capture = source.capture.bind(source)
    const reference = JsonValue.parse(source.reference)
    assert()
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Workspace move no longer owns its target reservation")
        await Storage.write(key(request), Record.parse({ ...current, native: reference }))
      },
      { commitGuard: assert },
    )
    const result = await capture(store, async (info, root, assertSource) => {
      const check = () => {
        assert()
        assertSource()
      }
      check()
      if (
        info.id !== request.source.workspaceID ||
        info.scopeID !== request.source.scopeID ||
        info.binding.generation !== request.source.generation ||
        !info.binding.physicalID
      )
        reject(request, "Workspace move source binding changed")
      const bytes = new TextEncoder().encode(JSON.stringify(Portable.Root.parse(root)))
      const manifest = WorkspaceTree.hash(bytes)
      await store.put(manifest, bytes)
      await WorkspaceArchive.copyManifest({ manifest, source: store }, { async put() {} }, signal)
      check()
      const retained = await read(request)
      if (retained?.candidate && retained.candidate !== manifest)
        reject(request, "Workspace move final captured tree changed")
      await Storage.transaction(
        async () => {
          const current = await read(request)
          if (!current || !held(current) || (current.candidate && current.candidate !== manifest))
            reject(request, "Workspace move final capture belongs to another attempt")
          await Storage.write(key(request), Record.parse({ ...current, candidate: manifest }))
        },
        { commitGuard: check },
      )
      const prepared = await WorkspaceContent.prepareTreeImport(request.target, { path: request.target.path, manifest })
      check()
      const proposed = WorkspaceCatalog.Info.parse({
        ...prepared.info,
        content: { revision: (prepared.info.content?.revision ?? 0) + 1, manifest: prepared.manifest },
      })
      const subtreeHash = await subtree(proposed, store, request.target.path)
      check()
      await Storage.transaction(
        async () => {
          await RuntimeMaintenance.assertAdmission()
          const current = await read(request)
          if (!current || current.state !== "preparing" || current.candidate !== manifest)
            reject(request, "Workspace move final publication attempt changed")
          await Storage.write(key(request), Record.parse({ ...current, state: "publishing" }))
        },
        { commitGuard: check },
      )
      const permit = { request, digest: hash(request), open: true, assert: check }
      try {
        return await publication.run(permit, () =>
          Storage.transaction(
            async () => {
              check()
              await RuntimeMaintenance.assertAdmission()
              const current = await read(request)
              if (current?.receipt) return Receipt.parse(current.receipt)
              if (!current || !held(current)) reject(request, "Workspace move lost its target reservation")
              const latest = await WorkspaceCatalog.get(request.target.workspaceID, request.target.scopeID)
              if (
                latest.activeMount ||
                latest.binding.generation !== request.target.generation ||
                latest.revision !== request.target.expectedRevision
              )
                reject(request, "Workspace move target changed before publication")
              const published = await prepared.publish()
              const receipt = Receipt.parse({
                version: 1,
                id: request.id,
                requestHash: current.digest,
                mappingRevision: request.mappingRevision,
                acceptedDiffHash: request.acceptedDiffHash,
                source: {
                  ...request.source,
                  hostID: info.binding.hostID,
                  physicalID: info.binding.physicalID,
                  manifest,
                },
                target: {
                  workspaceID: latest.id,
                  scopeID: latest.scopeID,
                  generation: latest.binding.generation,
                  path: request.target.path,
                  before: latest.content ?? { revision: 0, manifest: null },
                  after: published.content,
                  revision: published.revision,
                  mount: null,
                  mountGeneration: latest.mountGeneration ?? 0,
                },
                subtreeHash,
                publishedAt: Date.now(),
              })
              await Storage.write(key(request), Record.parse({ ...current, receipt, state: "published" }))
              return receipt
            },
            { commitGuard: check },
          ),
        )
      } catch (error) {
        check()
        const observed = await read(request)
        if (observed?.receipt) return Receipt.parse(observed.receipt)
        throw error
      } finally {
        permit.open = false
      }
    })
    assert()
    await releaseNative(request)
    assert()
    return result
  }
  export async function release(value: Request, outcome: "activated" | "cancelled" | "retired") {
    const request = Request.parse(value)
    const assert = WorkspaceContent.captureOwner()
    const accepted = state().jobs.get(JSON.stringify(key(request)))
    accepted?.assertOwner()
    if (accepted && running.getStore() === accepted.assertOwner)
      reject(request, "Workspace move release cannot reenter its accepted run")
    await Storage.transaction(
      async () => {
        const record = await read(request)
        if (!record) reject(request, "Workspace move is unknown")
        if (!held(record) && record.state !== outcome)
          reject(request, "Workspace move already has another permanent outcome")
        if (outcome === "activated" && !record.receipt)
          reject(request, "Unpublished Workspace move cannot be activated")
        await Storage.write(key(request), Record.parse({ ...record, state: outcome }))
        await Storage.remove(indexKey(request))
      },
      { commitGuard: assert },
    )
    assert()
    if (accepted) {
      await Promise.allSettled([accepted.promise])
      accepted.assertOwner()
      assert()
    }
    await releaseNative(request)
    assert()
    return inspect(request)
  }
}
