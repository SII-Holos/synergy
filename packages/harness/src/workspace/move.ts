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
import { WorkspaceDifference } from "./difference"
import type { Migration } from "../migration/types"
import { upgradeAccessRecord } from "../migration/import"

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
  export const NativeRequest = Request.omit({ target: true, acceptedDiffHash: true }).extend({
    kind: z.literal("native-adoption"),
    target: Selection.extend({ path: z.literal(""), expectedRevision: z.number().int().positive().safe() }),
    sourceSnapshotHash: WorkspaceTree.Hash,
  })
  export type NativeRequest = z.infer<typeof NativeRequest>
  const Input = z.union([Request, NativeRequest])
  type Input = z.infer<typeof Input>
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
  export const NativeReceipt = z.strictObject({
    version: z.literal(1),
    id: ID,
    requestHash: WorkspaceTree.Hash,
    mappingRevision: z.number().int().positive().safe(),
    sourceSnapshotHash: WorkspaceTree.Hash,
    acceptedDiffHash: WorkspaceTree.Hash,
    outcome: z.literal("adopted-target-version"),
    target: Selection.extend({
      revision: z.number().int().positive().safe(),
      catalogueHash: WorkspaceTree.Hash,
      manifest: WorkspaceTree.Hash,
      hostID: ID,
      physicalID: z.string().min(1),
    }),
    preparedAt: z.number().int().nonnegative().safe(),
  })
  export type NativeReceipt = z.infer<typeof NativeReceipt>
  export const NativeConsent = WorkspaceDifference.Summary.pick({
    sourceSnapshotHash: true,
    targetDigest: true,
    diffHash: true,
  }).strip()
  export const nativeReceiptHash = (value: NativeReceipt) => hash(NativeReceipt.parse(value))
  export interface NativeInput {
    source: { snapshot: WorkspaceArchive.Subtree; store: BlobStore; assert(): void; recheck(): Promise<void> }
    store: BlobStore
    signal?: AbortSignal
  }
  export const CapturedSource = Selection.extend({
    hostID: ID,
    physicalID: z.string().min(1),
    manifest: WorkspaceTree.Hash,
  })
  export interface CapturedSourceHost {
    capture<T>(
      request: Readonly<Request>,
      store: BlobStore,
      consume: (
        source: z.infer<typeof CapturedSource>,
        assertCurrent: () => void,
        recheck: () => Promise<void>,
      ) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T>
  }
  const LegacyRecord = z.strictObject({
    version: z.literal(1),
    digest: WorkspaceTree.Hash,
    request: Request,
    state: z.enum(["preparing", "publishing", "published", "activated", "cancelled", "retired"]),
    nativeRequested: z.boolean().default(false),
    native: JsonValue.optional(),
    candidate: WorkspaceTree.Hash.optional(),
    receipt: Receipt.optional(),
  })
  const PreviousRecord = LegacyRecord.extend({
    version: z.literal(2),
    request: Input,
    preview: WorkspaceDifference.Summary.optional(),
    snapshot: z.lazy(() => WorkspaceArchive.Subtree).optional(),
    nativeReceipt: NativeReceipt.optional(),
    nativePublication: WorkspaceTree.Hash.optional(),
  })
  const NativeNamespaceSelection = z.strictObject({
    root: z.string().min(1),
    artifacts: z.string().min(1),
    target: WorkspaceTree.Hash,
    storeID: z.uuid(),
    artifactStoreID: z.uuid(),
  })
  const NativeNamespace = z.strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    selection: NativeNamespaceSelection.optional(),
  })
  const Record = PreviousRecord.extend({ version: z.literal(3), nativeNamespace: NativeNamespace }).refine(
    (record) =>
      record.nativeNamespace.version === 1 ||
      (!record.nativeRequested && record.native === undefined) ||
      !!record.nativeNamespace.selection,
    "Native dispatch requires its original dataset selection",
  )
  type Record = z.infer<typeof Record>
  export const migration: Migration = {
    id: "20261113-workspace-native-adoption",
    description: "Version retained Workspace move intents for explicit native target adoption",
    scope: "global",
    execution: "record",
    async up() {},
    upgradeRecord(key, value) {
      if (key.length !== 3 || key[0] !== "workspace_move" || value.version !== 1) return
      LegacyRecord.parse(value)
      value.version = 2
      PreviousRecord.parse(value)
    },
  }
  export const namespaceMigration: Migration = {
    id: "20261113-workspace-native-dispatch-namespace",
    description: "Retain legacy native dispatch identity while anchoring new claims to their dataset",
    scope: "global",
    execution: "record",
    dependsOn: ["workspace/20261113-workspace-native-adoption"],
    async up() {},
    upgradeRecord(key, value) {
      if (key.length !== 3 || key[0] !== "workspace_move" || value.version !== 2) return
      PreviousRecord.parse(value)
      value.version = 3
      value.nativeNamespace = { version: 1 }
      Record.parse(value)
    },
  }
  const LegacyStatus = LegacyRecord.omit({ native: true })
  const CurrentStatus = PreviousRecord.omit({ native: true })
  export const Status = z.union([LegacyStatus, CurrentStatus])
  function status(record: Record) {
    const { native: _, nativeNamespace: _namespace, ...visible } = record
    if ("kind" in record.request) return CurrentStatus.parse({ ...visible, version: 2 })
    return LegacyStatus.parse({
      version: 1,
      digest: record.digest,
      request: record.request,
      state: record.state,
      nativeRequested: record.nativeRequested,
      candidate: record.candidate,
      receipt: record.receipt,
    })
  }
  export interface SourceLease {
    readonly reference: z.infer<typeof JsonValue>
    capture<T>(
      store: BlobStore,
      consume: (info: WorkspaceCatalog.Info, root: Portable.Root, assertCurrent: () => void) => Promise<T>,
    ): Promise<T>
  }
  export interface SourceHost {
    preview<T>(
      source: Request["source"],
      store: BlobStore,
      consume: (info: WorkspaceCatalog.Info, root: Portable.Root, assertCurrent: () => void) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T>
    hold(
      source: Request["source"],
      id: string,
      previous: z.infer<typeof JsonValue> | undefined,
      signal?: AbortSignal,
      compatibleIDs?: readonly string[],
    ): Promise<SourceLease>
    release(
      source: Request["source"],
      id: string,
      reference: z.infer<typeof JsonValue> | undefined,
      compatibleIDs?: readonly string[],
    ): Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    host: undefined as SourceHost | undefined,
    captured: new Map<string, CapturedSourceHost>(),
    jobs: new Map<
      string,
      { digest: string; source: string; promise: Promise<unknown>; terminal?: boolean; assertOwner(): void }
    >(),
  }))
  const running = RuntimeContext.createAsyncContext<() => void>()
  const publication = RuntimeContext.createAsyncContext<{
    request: Request
    digest: string
    open: boolean
    assert(): void
  }>()
  const key = (request: Input) => ["workspace_move", request.target.scopeID, request.id]
  const active = (scopeID: string, workspaceID: string) => ["workspace_move_active", scopeID, workspaceID]
  const indexKey = (request: Input) => [...active(request.target.scopeID, request.target.workspaceID), request.id]
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  export function receiptHash(value: Receipt) {
    return hash(Receipt.parse(value))
  }
  export function requestHash(value: Request) {
    return hash(Request.parse(value))
  }
  function nativePrimary() {
    const runtime = RuntimeContext.current(),
      handle = Storage.current(),
      primary = runtime.storage
    if (
      !primary ||
      handle.store !== primary.store ||
      handle.store.options.readonly ||
      handle.artifactDirectory !== primary.artifactDirectory ||
      handle.artifactObjects !== primary.artifactObjects
    )
      throw new Error("Native Workspace claims require their actual writable primary Store")
    return handle
  }
  function legacyNativeIDs(request: Input) {
    const handle = nativePrimary(),
      ids = new Set<string>()
    for (const readonly of [undefined, false])
      for (const recover of [undefined, false, true])
        for (const mustExist of [undefined, false, true])
          ids.add(
            "workspace-move:" +
              hash([
                request,
                RuntimeContext.current().host.root,
                { ...handle.store.options, readonly, recover, mustExist },
                handle.artifactDirectory,
              ]),
          )
    return [...ids]
  }
  async function nativeDispatch(request: Input, record: Record) {
    const assert = WorkspaceContent.captureOwner(),
      handle = nativePrimary(),
      runtime = RuntimeContext.current()
    const { StorageBootstrap } = await import("../storage/bootstrap")
    const identity = await StorageBootstrap.currentIdentity()
    assert()
    nativePrimary()
    const selection = NativeNamespaceSelection.parse({
      ...identity,
      root: runtime.host.root,
      artifacts: handle.artifactDirectory,
    })
    if (
      record.nativeNamespace.selection &&
      JSON.stringify(record.nativeNamespace.selection) !== JSON.stringify(selection)
    )
      reject(request, "Native Workspace claim belongs to another original dataset")
    return {
      id: "workspace-move:v2:" + hash([request, selection]),
      compatibleIDs: record.nativeNamespace.version === 1 ? legacyNativeIDs(request) : [],
      namespace: NativeNamespace.parse({ ...record.nativeNamespace, selection }),
    }
  }
  const contains = (parent: string, child: string) => !parent || child === parent || child.startsWith(parent + "/")
  const overlaps = (left: string, right: string) => contains(left, right) || contains(right, left)
  const held = (record: Record) => ["preparing", "publishing", "published"].includes(record.state)
  function reject(request: Input, message: string): never {
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
    state().host = Object.freeze({
      preview: value.preview.bind(value),
      hold: value.hold.bind(value),
      release: value.release.bind(value),
    })
  }
  export function registerCapturedSourceHost(id: string, value: CapturedSourceHost) {
    RuntimeContext.assertCompositionOpen("Captured Workspace move source")
    ID.parse(id)
    if (id === "native" || state().captured.has(id))
      throw new Error("Captured Workspace move source is already registered")
    state().captured.set(id, Object.freeze({ capture: value.capture.bind(value) }))
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
          const selected = Record.parse(upgradeAccessRecord(row.key, row.value))
          if (JSON.stringify(key(selected.request)) !== JSON.stringify(row.key))
            reject(selected.request, "Workspace move has another canonical maintenance key")
          const record = await read(selected.request)
          if (!record) reject(selected.request, "Workspace move disappeared during maintenance inspection")
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
  async function read(request: Input): Promise<Record | undefined> {
    const [raw] = await Storage.readMany([key(request)])
    if (raw === undefined) return
    const record = Record.parse(upgradeAccessRecord(key(request), raw))
    if (record.digest !== hash(request) || JSON.stringify(record.request) !== JSON.stringify(request))
      reject(request, "Workspace move identity already has different input")
    if (!("kind" in request) && (record.preview || record.snapshot || record.nativeReceipt || record.nativePublication))
      reject(request, "Object Workspace move contains native adoption metadata")
    if (
      record.nativeReceipt &&
      (record.nativeReceipt.requestHash !== record.digest || record.nativeReceipt.id !== request.id)
    )
      reject(request, "Native Workspace receipt belongs to another original request")
    if ("kind" in request) {
      if (
        record.nativePublication &&
        (!record.nativeReceipt || record.nativePublication !== nativeReceiptHash(record.nativeReceipt))
      )
        reject(request, "Native Workspace publication has another complete receipt")
      if (
        (record.state === "activated" && !record.nativePublication) ||
        (["cancelled", "retired"].includes(record.state) && record.nativePublication)
      )
        reject(request, "Native Workspace publication has another permanent outcome")
      if (record.receipt) reject(request, "Native Workspace move cannot borrow an object publication receipt")
      if (
        record.snapshot &&
        (WorkspaceArchive.subtreeHash(record.snapshot) !== request.sourceSnapshotHash ||
          hash(record.snapshot.files) !== record.snapshot.manifest)
      )
        reject(request, "Native Workspace source snapshot is corrupt")
      if (
        record.preview &&
        (!record.snapshot ||
          record.preview.requestHash !== record.digest ||
          record.preview.sourceSnapshotHash !== request.sourceSnapshotHash)
      )
        reject(request, "Native Workspace difference belongs to another request")
      if (
        record.nativeReceipt &&
        (!record.preview ||
          record.nativeReceipt.mappingRevision !== request.mappingRevision ||
          record.nativeReceipt.sourceSnapshotHash !== request.sourceSnapshotHash ||
          record.nativeReceipt.acceptedDiffHash !== record.preview.diffHash ||
          record.nativeReceipt.target.manifest !== record.preview.targetDigest ||
          record.nativeReceipt.target.workspaceID !== request.target.workspaceID ||
          record.nativeReceipt.target.scopeID !== request.target.scopeID ||
          record.nativeReceipt.target.generation !== request.target.generation ||
          record.nativeReceipt.target.revision !== request.target.expectedRevision)
      )
        reject(request, "Native Workspace receipt changed its complete target or consent")
      if (["publishing", "published", "activated"].includes(record.state) && !record.nativeReceipt)
        reject(request, "Native Workspace move has no complete prepared receipt")
    }
    return record
  }
  async function* reservations(info: Pick<WorkspaceCatalog.Info, "id" | "scopeID">) {
    for await (const row of Storage.records({ prefix: active(info.scopeID, info.id), limit: 128 })) {
      const request = Input.parse(row.value)
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
  async function prepare(request: Input) {
    return Storage.transaction(async () => {
      const existing = await read(request)
      if (existing) return existing
      await RuntimeMaintenance.assertAdmission()
      const info = await WorkspaceCatalog.get(request.target.workspaceID, request.target.scopeID)
      if (
        info.backend?.provider !== ("kind" in request ? "directory" : "objects") ||
        info.lifecycle !== "active" ||
        info.binding.state !== "bound" ||
        info.activeMount
      )
        reject(request, "Workspace move requires a dormant object target without an active mount")
      if (info.binding.generation !== request.target.generation || info.revision !== request.target.expectedRevision)
        reject(request, "Workspace move target version changed")
      await assertMutation(info, [request.target.path])
      if (
        "kind" in request &&
        (!info.binding.path || !info.binding.physicalID || info.sharedWritableWorkspaceIDs.length)
      )
        reject(request, "Native adoption requires its original physical directory")
      const record = Record.parse({
        version: 3,
        request,
        digest: hash(request),
        state: "preparing",
        nativeNamespace: { version: 2 },
      })
      await Storage.write(key(request), record)
      await Storage.write(indexKey(request), request)
      return record
    })
  }
  export async function reserve(value: Request, signal?: AbortSignal) {
    const request = Request.parse(value)
    const assert = WorkspaceContent.captureOwner(signal)
    return Storage.transaction(
      async () => {
        const record = await prepare(request)
        assert()
        return status(record)
      },
      { commitGuard: assert },
    )
  }
  function physical(request: Input) {
    const selected = "kind" in request ? request.target : request.source
    return { workspaceID: selected.workspaceID, scopeID: selected.scopeID, generation: selected.generation }
  }
  async function releaseNative(request: Input) {
    const assert = WorkspaceContent.captureOwner()
    const record = await read(request)
    assert()
    if (!record || (!record.nativeRequested && record.native === undefined)) return
    const dispatch = await nativeDispatch(request, record)
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || JSON.stringify(current.native) !== JSON.stringify(record.native))
          reject(request, "Workspace move source claim changed")
        await Storage.write(key(request), Record.parse({ ...current, nativeNamespace: dispatch.namespace }))
      },
      {
        commitGuard() {
          assert()
          nativePrimary()
        },
      },
    )
    await host().release(physical(request), dispatch.id, record.native, dispatch.compatibleIDs)
    assert()
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || JSON.stringify(current.native) !== JSON.stringify(record.native))
          reject(request, "Workspace move source claim changed")
        await Storage.write(key(request), Record.parse({ ...current, nativeRequested: false, native: undefined }))
      },
      {
        commitGuard() {
          assert()
          nativePrimary()
        },
      },
    )
  }
  export async function inspect(value: Input) {
    const request = Input.parse(value)
    const assert = WorkspaceContent.captureOwner()
    const record = await Storage.snapshot(() => read(request))
    assert()
    if (!record) return
    const { native: _, ...view } = record
    return status(Record.parse(view))
  }
  export async function requestForTarget(value: { id: string; workspaceID: string; scopeID: string }) {
    const input = z.strictObject({ id: ID, workspaceID: ID, scopeID: ID }).parse(value),
      assert = WorkspaceContent.captureOwner()
    return Storage.snapshot(async () => {
      const selected = ["workspace_move", input.scopeID, input.id]
      const [raw] = await Storage.readMany([selected])
      assert()
      if (raw === undefined) return
      const current = Record.parse(upgradeAccessRecord(selected, raw))
      if (
        current.request.target.scopeID !== input.scopeID ||
        current.request.target.workspaceID !== input.workspaceID ||
        current.request.id !== input.id
      )
        reject(current.request, "Workspace move lookup has another original target")
      await read(current.request)
      assert()
      return Input.parse(current.request)
    })
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
    return runOwned(
      request,
      signal,
      "native",
      (assert) => execute(request, signal, assert),
      (value) => Receipt.parse(value),
    )
  }
  export async function runCaptured(
    value: Request,
    sourceID: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Receipt> {
    const request = Request.parse(value)
    const signal = options.signal
    const source = state().captured.get(ID.parse(sourceID))
    if (!source) reject(request, "Captured Workspace move source is not registered")
    const capture = source.capture.bind(source)
    return runOwned(
      request,
      signal,
      sourceID,
      (assert) => executeCaptured(request, signal, assert, capture),
      (value) => Receipt.parse(value),
    )
  }
  async function runOwned<T>(
    request: Input,
    signal: AbortSignal | undefined,
    source: string,
    execute: (assert: () => void) => Promise<T>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const assert = WorkspaceContent.captureOwner(signal)
    assert()
    const jobKey = JSON.stringify(key(request))
    const digest = hash(request)
    const existing = state().jobs.get(jobKey)
    if (existing) {
      existing.assertOwner()
      if (existing.digest !== digest || existing.source !== source)
        reject(request, "Workspace move identity already has different input or source")
      return parse(await existing.promise)
    }
    const assertOwner = WorkspaceContent.captureOwner()
    const promise = running.run(assertOwner, () => execute(assert))
    state().jobs.set(jobKey, { digest, source, promise, assertOwner })
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
    const dispatch = await nativeDispatch(request, record)
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Workspace move no longer owns its target reservation")
        await Storage.write(
          key(request),
          Record.parse({ ...current, nativeRequested: true, nativeNamespace: dispatch.namespace }),
        )
      },
      { commitGuard: assert },
    )
    const source = await host().hold(request.source, dispatch.id, record.native, signal, dispatch.compatibleIDs)
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
      return publishCaptured(
        request,
        store,
        { ...request.source, hostID: info.binding.hostID, physicalID: info.binding.physicalID, manifest },
        signal,
        check,
      )
    })
    assert()
    await releaseNative(request)
    assert()
    return result
  }
  async function publishCaptured(
    request: Request,
    store: BlobStore,
    source: z.infer<typeof CapturedSource>,
    signal: AbortSignal | undefined,
    check: () => void,
    recheck?: () => Promise<void>,
  ) {
    const manifest = source.manifest
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
            await recheck?.()
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
                hostID: source.hostID,
                physicalID: source.physicalID,
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
  }
  async function executeCaptured(
    request: Request,
    signal: AbortSignal | undefined,
    assert: () => void,
    capture: CapturedSourceHost["capture"],
  ): Promise<Receipt> {
    const record = await prepare(request)
    assert()
    if (record.nativeRequested || record.native !== undefined)
      reject(request, "Workspace move retains an original native dispatch")
    if (!held(record)) reject(request, "Workspace move was permanently cancelled or retired")
    if (record.state === "publishing" && !record.receipt)
      reject(request, "Workspace move publication is unresolved; inspect the original moveID")
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
    let open = true
    let accepted: Promise<Receipt> | undefined
    try {
      await capture(
        Request.parse(request),
        store,
        (value, assertSource, recheckSource) => {
          if (!open || accepted) reject(request, "Captured Workspace move source callback has ended or repeated")
          const source = CapturedSource.parse(value)
          const verify = recheckSource.bind(undefined)
          const check = () => {
            assert()
            if (!open) reject(request, "Captured Workspace move source callback has ended")
            assertSource()
          }
          check()
          if (
            source.workspaceID !== request.source.workspaceID ||
            source.scopeID !== request.source.scopeID ||
            source.generation !== request.source.generation
          )
            reject(request, "Captured Workspace move source binding changed")
          accepted = (async () => {
            if (record.receipt) {
              if (JSON.stringify(record.receipt.source) !== JSON.stringify(source))
                reject(request, "Captured Workspace move source differs from its original receipt")
              check()
              return Receipt.parse(record.receipt)
            }
            return publishCaptured(request, store, source, signal, check, verify)
          })()
          return accepted
        },
        signal,
      )
      assert()
      if (!accepted) reject(request, "Captured Workspace move source did not provide its original snapshot")
      return await accepted
    } finally {
      open = false
      if (accepted) await Promise.allSettled([accepted])
    }
  }
  function nativeInput(value: NativeInput): NativeInput {
    const source = value.source,
      store = value.store
    return {
      source: {
        snapshot: WorkspaceArchive.Subtree.parse(source.snapshot),
        store: { get: source.store.get.bind(source.store), put: source.store.put.bind(source.store) },
        assert: source.assert.bind(source),
        recheck: source.recheck.bind(source),
      },
      store: { get: store.get.bind(store), put: store.put.bind(store) },
      signal: value.signal,
    }
  }
  function nativeInfo(request: NativeRequest, info: WorkspaceCatalog.Info) {
    if (
      info.id !== request.target.workspaceID ||
      info.scopeID !== request.target.scopeID ||
      info.revision !== request.target.expectedRevision ||
      info.binding.generation !== request.target.generation ||
      info.backend?.provider !== "directory" ||
      info.lifecycle !== "active" ||
      info.binding.state !== "bound" ||
      !info.binding.path ||
      !info.binding.physicalID ||
      info.activeMount ||
      info.sharedWritableWorkspaceIDs.length
    )
      reject(request, "Native Workspace target catalogue changed")
  }
  async function nativeSource(request: NativeRequest, input: NativeInput, assert: () => void) {
    assert()
    input.source.assert()
    const snapshot = input.source.snapshot
    if (
      WorkspaceArchive.subtreeHash(snapshot) !== request.sourceSnapshotHash ||
      hash(snapshot.files) !== snapshot.manifest
    )
      reject(request, "Native adoption source snapshot changed")
    await input.source.recheck()
    assert()
    input.source.assert()
    const record = await read(request)
    if (!record || !held(record)) reject(request, "Native adoption no longer owns its original move")
    if (record.snapshot) {
      if (JSON.stringify(record.snapshot) !== JSON.stringify(snapshot))
        reject(request, "Native adoption source snapshot changed")
      return
    }
    await WorkspaceArchive.copyManifest(
      { manifest: snapshot.manifest, source: input.source.store },
      input.store,
      input.signal,
    )
    assert()
    input.source.assert()
    await input.source.recheck()
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Native adoption no longer owns its original source")
        if (current.snapshot && JSON.stringify(current.snapshot) !== JSON.stringify(snapshot))
          reject(request, "Native adoption source snapshot changed")
        await Storage.write(key(request), Record.parse({ ...current, snapshot }))
      },
      {
        commitGuard() {
          assert()
          input.source.assert()
        },
      },
    )
  }
  async function nativeClaim(request: NativeRequest, signal: AbortSignal | undefined, assert: () => void) {
    const record = await read(request)
    if (!record || !held(record)) reject(request, "Native adoption no longer owns its original target")
    const dispatch = await nativeDispatch(request, record)
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Native adoption no longer owns its original target")
        await Storage.write(
          key(request),
          Record.parse({ ...current, nativeRequested: true, nativeNamespace: dispatch.namespace }),
        )
      },
      { commitGuard: assert },
    )
    const lease = await host().hold(physical(request), dispatch.id, record.native, signal, dispatch.compatibleIDs)
    const reference = JsonValue.parse(lease.reference)
    assert()
    await Storage.transaction(
      async () => {
        const current = await read(request)
        if (!current || !held(current)) reject(request, "Native adoption ended during native admission")
        await Storage.write(key(request), Record.parse({ ...current, native: reference }))
      },
      { commitGuard: assert },
    )
    return lease
  }
  export async function previewNative(
    value: NativeRequest,
    options: NativeInput,
  ): Promise<WorkspaceDifference.Summary> {
    const request = NativeRequest.parse(value),
      input = nativeInput(options)
    if (Storage.inTransaction())
      reject(request, "Native Workspace preview must run outside the publication transaction")
    return runOwned(
      request,
      input.signal,
      "native-adoption-preview",
      async (assert) => {
        const record = await prepare(request)
        if (!held(record) || record.nativeReceipt)
          reject(request, "Native adoption preparation cannot replace its retained target")
        await nativeSource(request, input, assert)
        const check = () => {
          assert()
          input.source.assert()
        }
        const consume = async (info: WorkspaceCatalog.Info, root: Portable.Root, physical: () => void) => {
          const guard = () => {
            check()
            physical()
          }
          guard()
          nativeInfo(request, info)
          const current = await read(request)
          if (!current || !held(current)) reject(request, "Native Workspace preview lost its original move")
          const targetDigest = hash(Portable.Root.parse(root))
          if (current.preview?.targetDigest === targetDigest) {
            await WorkspaceDifference.verify(current.preview, guard)
            return current.preview
          }
          const preview = await WorkspaceDifference.build({
            requestHash: hash(request),
            sourceSnapshotHash: request.sourceSnapshotHash,
            source: input.source.snapshot.files,
            target: root,
            store: input.store,
            signal: input.signal,
            assert: guard,
          })
          await input.source.recheck()
          guard()
          return Storage.transaction(
            async () => {
              const latest = await read(request)
              if (!latest || !held(latest) || latest.nativeReceipt)
                reject(request, "Native Workspace preview no longer owns its target")
              nativeInfo(request, await WorkspaceCatalog.get(info.id, info.scopeID))
              if (latest.preview && latest.preview.index !== preview.index)
                await WorkspaceDifference.discard(latest.preview)
              await Storage.write(key(request), Record.parse({ ...latest, preview }))
              return preview
            },
            { commitGuard: guard },
          )
        }
        if (record.nativeRequested || record.native !== undefined) {
          const lease = await nativeClaim(request, input.signal, check)
          return lease.capture(input.store, consume)
        }
        return host().preview(physical(request), input.store, consume, input.signal)
      },
      (value) => WorkspaceDifference.Summary.parse(value),
    )
  }
  export async function nativeDifference(
    value: NativeRequest,
    options: { expectedRevision: string; cursor?: string; limit: number },
  ) {
    const request = NativeRequest.parse(value)
    const query = z
      .strictObject({
        expectedRevision: WorkspaceTree.Hash,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(64),
      })
      .parse(options)
    const assert = WorkspaceContent.captureOwner()
    return Storage.snapshot(async () => {
      const record = await read(request)
      assert()
      if (!record?.preview || record.preview.diffHash !== query.expectedRevision)
        reject(request, "Native Workspace difference changed")
      return WorkspaceDifference.page(record.preview, { ...query, assert })
    })
  }
  export async function prepareNative(
    value: NativeRequest,
    options: NativeInput & { consent: z.infer<typeof NativeConsent> },
  ): Promise<NativeReceipt> {
    const request = NativeRequest.parse(value),
      input = nativeInput(options),
      consent = NativeConsent.parse(options.consent)
    if (Storage.inTransaction())
      reject(request, "Native Workspace preparation must run outside the publication transaction")
    return runOwned(
      request,
      input.signal,
      "native-adoption",
      async (assert) => {
        const record = await prepare(request)
        if (
          !held(record) ||
          !record.preview ||
          JSON.stringify(NativeConsent.parse(record.preview)) !== JSON.stringify(consent)
        )
          reject(request, "Native Workspace difference consent changed or is missing")
        await nativeSource(request, input, assert)
        const check = () => {
          assert()
          input.source.assert()
        }
        const lease = await nativeClaim(request, input.signal, check)
        return lease.capture(input.store, async (info, root, physical) => {
          const guard = () => {
            check()
            physical()
          }
          guard()
          nativeInfo(request, info)
          if (hash(Portable.Root.parse(root)) !== consent.targetDigest)
            reject(request, "Native Workspace target changed after difference consent")
          await WorkspaceDifference.verify(record.preview!, guard)
          await input.source.recheck()
          guard()
          const receipt =
            record.nativeReceipt ??
            NativeReceipt.parse({
              version: 1,
              id: request.id,
              requestHash: hash(request),
              mappingRevision: request.mappingRevision,
              sourceSnapshotHash: request.sourceSnapshotHash,
              acceptedDiffHash: consent.diffHash,
              outcome: "adopted-target-version",
              target: {
                ...physicalSelection(request),
                revision: info.revision,
                catalogueHash: hash(info),
                manifest: consent.targetDigest,
                hostID: info.binding.hostID,
                physicalID: info.binding.physicalID,
              },
              preparedAt: Date.now(),
            })
          return Storage.transaction(
            async () => {
              const current = await read(request)
              if (
                !current ||
                !held(current) ||
                !current.preview ||
                JSON.stringify(NativeConsent.parse(current.preview)) !== JSON.stringify(consent)
              )
                reject(request, "Native Workspace consent changed before preparation")
              const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
              nativeInfo(request, latest)
              if (hash(latest) !== receipt.target.catalogueHash)
                reject(request, "Native Workspace target catalogue changed")
              if (current.nativeReceipt && JSON.stringify(current.nativeReceipt) !== JSON.stringify(receipt))
                reject(request, "Native Workspace preparation changed its original receipt")
              await Storage.write(
                key(request),
                Record.parse({ ...current, state: "published", nativeReceipt: receipt }),
              )
              return receipt
            },
            { commitGuard: guard },
          )
        })
      },
      (value) => NativeReceipt.parse(value),
    )
  }
  function physicalSelection(request: NativeRequest) {
    return {
      workspaceID: request.target.workspaceID,
      scopeID: request.target.scopeID,
      generation: request.target.generation,
    }
  }
  const nativePublication = RuntimeContext.createAsyncContext<{ digest: string; receipt: string; assert(): void }>()
  export function assertNativePublication(value: NativeRequest, receipt: NativeReceipt) {
    const request = NativeRequest.parse(value),
      selected = NativeReceipt.parse(receipt),
      frame = nativePublication.getStore()
    if (!frame || frame.digest !== hash(request) || frame.receipt !== nativeReceiptHash(selected))
      reject(request, "Native Workspace publication requires its original retained claim")
    frame.assert()
  }
  export async function publishNative(value: NativeRequest, proof: NativeReceipt) {
    const request = NativeRequest.parse(value),
      receipt = NativeReceipt.parse(proof)
    if (!Storage.inWriteTransaction())
      reject(request, "Native Workspace publication must join its actual publication transaction")
    assertNativePublication(request, receipt)
    const current = await read(request)
    if (!current || !held(current) || JSON.stringify(current.nativeReceipt) !== JSON.stringify(receipt))
      reject(request, "Native Workspace publication lost its target reservation")
    await Storage.write(key(request), Record.parse({ ...current, nativePublication: nativeReceiptHash(receipt) }))
    await Storage.transaction(async () => {}, { commitGuard: () => assertNativePublication(request, receipt) })
  }
  export async function withNativePublication<T>(
    value: NativeRequest,
    proof: NativeReceipt,
    body: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const request = NativeRequest.parse(value),
      receipt = NativeReceipt.parse(proof),
      assert = WorkspaceContent.captureOwner(signal),
      assertOwner = WorkspaceContent.captureOwner()
    if (Storage.inTransaction())
      reject(request, "Native Workspace capture must run outside the publication transaction")
    const jobKey = JSON.stringify(key(request))
    if (state().jobs.has(jobKey)) reject(request, "Native Workspace publication already has accepted work")
    const promise = running.run(assertOwner, async () => {
      const record = await read(request)
      assert()
      if (!record || !held(record) || JSON.stringify(record.nativeReceipt) !== JSON.stringify(receipt))
        reject(request, "Native Workspace publication has another prepared receipt")
      const store: BlobStore = {
        async get() {
          throw new Error("Native verification never reads stored bytes")
        },
        async put() {},
      }
      const lease = await nativeClaim(request, signal, assert)
      return lease.capture(store, async (info, root, physical) => {
        let open = true
        const check = () => {
          assert()
          physical()
          if (state().jobs.get(jobKey)?.terminal)
            reject(request, "Native Workspace publication lost its target reservation")
          if (!open) reject(request, "Native Workspace publication callback has ended")
        }
        check()
        nativeInfo(request, info)
        if (hash(info) !== receipt.target.catalogueHash || hash(Portable.Root.parse(root)) !== receipt.target.manifest)
          reject(request, "Native Workspace prepared target changed before publication")
        try {
          return await nativePublication.run(
            { digest: hash(request), receipt: nativeReceiptHash(receipt), assert: check },
            body,
          )
        } finally {
          open = false
        }
      })
    })
    state().jobs.set(jobKey, { digest: hash(request), source: "native-adoption-publication", promise, assertOwner })
    try {
      return await promise
    } finally {
      state().jobs.delete(jobKey)
    }
  }
  export async function release(value: Input, outcome: "activated" | "cancelled" | "retired") {
    const request = Input.parse(value)
    if (Storage.inTransaction()) reject(request, "Workspace move release must run outside its publication transaction")
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
        if (outcome === "activated" && !record.receipt && !record.nativeReceipt)
          reject(request, "Unpublished Workspace move cannot be activated")
        if ("kind" in request && (outcome === "activated" ? !record.nativePublication : !!record.nativePublication))
          reject(request, "Native Workspace publication requires its matching permanent outcome")
        await Storage.write(key(request), Record.parse({ ...record, state: outcome }))
        await Storage.remove(indexKey(request))
      },
      {
        commitGuard() {
          assert()
          if (accepted) accepted.terminal = true
        },
      },
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
