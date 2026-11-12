import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { withStorageQueueOptions } from "../storage/queue"
import { Lock } from "../util/lock"
import { JsonValue } from "../util/json-value"
import { WorkspaceCatalog } from "../workspace/catalog"
import type { BlobStore } from "../storage/blobs"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferStaging as Staging } from "./transfer-staging"
import { WorkspacePortableSchema as Schema } from "./workspace-portable-schema"
import { WorkspacePortableTargetGraph as Graph } from "./workspace-portable-target-graph"

export namespace WorkspacePortableTarget {
  const ID = z.string().min(1).max(4096)
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Native = z.strictObject({
    version: z.literal(1),
    workspaceID: ID,
    scopeID: ID,
    hostID: ID,
    path: ID,
    physicalID: ID,
    receipt: JsonValue,
  })
  export type Native = z.infer<typeof Native>
  export interface Host {
    prepare(input: {
      handoffID: string
      captured: Schema.Captured
      store: BlobStore
      signal: AbortSignal
    }): Promise<Native>
    validate(value: Native, signal: AbortSignal): Promise<void>
    withPublication<T>(values: readonly Native[], signal: AbortSignal, body: () => Promise<T>): Promise<T>
    assertPublication(value: Native): Native
  }
  export interface Provider {
    prepare(input: {
      handoffID: string
      captured: Schema.Captured
      signal: AbortSignal
    }): Promise<WorkspaceCatalog.Info>
    validate(catalog: WorkspaceCatalog.Info, signal: AbortSignal): Promise<void>
    withPublication<T>(
      values: readonly WorkspaceCatalog.Info[],
      signal: AbortSignal,
      body: () => Promise<T>,
    ): Promise<T>
    assertPublication(catalog: WorkspaceCatalog.Info): void
  }
  const Workspace = z.strictObject({
    version: z.literal(1),
    sourceWorkspaceID: ID,
    catalog: WorkspaceCatalog.Info,
    native: Native.optional(),
    provider: ID.optional(),
  })
  const Mapping = z.object({ workspaceIDs: z.record(z.string(), ID), workspaceReceiptHash: Hash })
  export const Prepared = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    manifestHash: Hash,
    sourceReceiptHash: Hash,
    hash: Hash,
  })
  export type Prepared = z.infer<typeof Prepared>
  const state = RuntimeContext.state(() => ({
    host: undefined as Host | undefined,
    providers: new Map<string, Provider>(),
  }))
  const selectedProvider = new AsyncLocalStorage<string>()
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const prefix = (handoffID: string) => ["workspace_portable_target", ID.parse(handoffID)]
  const workspaceKey = (handoffID: string, workspaceID: string) => [
    ...prefix(handoffID),
    "workspaces",
    digest(workspaceID),
  ]
  const preparedKey = (handoffID: string) => [...prefix(handoffID), "prepared"]
  const mappingKey = (handoffID: string, sessionID: string) => [...prefix(handoffID), "mappings", ID.parse(sessionID)]
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  export function registerHost(input: Host) {
    RuntimeContext.assertCompositionOpen("native Workspace target")
    if (state().host) fail("Native Workspace target is already registered")
    state().host = Object.freeze({
      prepare: input.prepare.bind(input),
      validate: input.validate.bind(input),
      withPublication: input.withPublication.bind(input),
      assertPublication: input.assertPublication.bind(input),
    })
  }
  export function registerProvider(id: string, input: Provider) {
    RuntimeContext.assertCompositionOpen("Workspace target providers")
    id = ID.parse(id)
    if (state().providers.has(id)) fail("Workspace target provider is already registered")
    state().providers.set(
      id,
      Object.freeze({
        prepare: input.prepare.bind(input),
        validate: input.validate.bind(input),
        withPublication: input.withPublication.bind(input),
        assertPublication: input.assertPublication.bind(input),
      }),
    )
  }
  export function withProvider<T>(id: string, body: () => Promise<T>) {
    if (!state().providers.has(id)) fail("Workspace target provider is unavailable")
    return selectedProvider.run(id, body)
  }
  function provider(id = selectedProvider.getStore()) {
    if (!id || id !== selectedProvider.getStore()) fail("Workspace target requires its original provider callback")
    const value = state().providers.get(id)
    if (!value) fail("Workspace target provider is unavailable")
    return value
  }
  function host() {
    const selected = state().host
    if (!selected) fail("This Runtime has no native Workspace target")
    return selected
  }
  function ownership(signal: AbortSignal) {
    signal.throwIfAborted()
    const runtime = RuntimeContext.current()
    const selected = Storage.current()
    const store = selected.store
    const directory = selected.artifactDirectory
    const objects = selected.artifactObjects
    const blobs = objects?.blobs
    const writerID = objects?.writerID
    const now = objects?.now
    const selectedHost = host()
    const providerID = selectedProvider.getStore()
    const source = providerID && provider(providerID)
    return () => {
      signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        current.artifactDirectory !== directory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== blobs ||
        objects?.writerID !== writerID ||
        objects?.now !== now ||
        state().host !== selectedHost ||
        selectedProvider.getStore() !== providerID ||
        (providerID && state().providers.get(providerID) !== source)
      )
        fail("Workspace target requires its original storage owner")
    }
  }
  async function readWorkspace(handoffID: string, workspaceID: string) {
    const [raw] = await Storage.readMany([workspaceKey(handoffID, workspaceID)])
    if (raw === undefined) return
    const value = Workspace.parse(raw)
    if (value.sourceWorkspaceID !== workspaceID) fail("Workspace target has another source identity")
    return value
  }
  async function* workspaces(handoffID: string) {
    for await (const row of Storage.records({ prefix: [...prefix(handoffID), "workspaces"], limit: 128 }))
      yield Workspace.parse(row.value)
  }
  export function prepare(input: {
    binding: Epochs.Binding
    expectedReceiptHash: string
    signal: AbortSignal
  }): Promise<Prepared> {
    const binding = Epochs.Binding.parse(input.binding)
    const expected = Hash.parse(input.expectedReceiptHash)
    const signal = input.signal
    const assert = ownership(signal)
    return withStorageQueueOptions({ signal }, async () => {
      if (Storage.inTransaction()) fail("Workspace target preparation must run outside activation")
      if (binding.rootSessionID && binding.rootSessionID !== binding.sessionID)
        fail("Workspace target requires its aggregate root")
      using lock = await Lock.writeWithSignal("workspace-target:" + binding.handoffID, signal)
      assert()
      if (!lock) fail("Workspace target could not acquire preparation ownership")
      const staging = await Staging.inspect(binding.handoffID)
      assert()
      if (staging.phase !== "verified") fail("Workspace target requires verified private staging")
      const [raw] = await Storage.readMany([preparedKey(binding.handoffID)])
      assert()
      if (raw !== undefined) {
        const previous = Prepared.parse(raw)
        if (
          digest(previous.binding) !== digest(binding) ||
          previous.sourceReceiptHash !== expected ||
          previous.manifestHash !== staging.rootHash
        )
          fail("Workspace target cannot replace its immutable preparation")
      }
      return Graph.withGraph(
        { handoffID: binding.handoffID, rootSessionID: binding.sessionID, scopeID: binding.scopeID, signal },
        async (graph) => {
          const source = await Schema.digest(binding, graph.rows(), signal)
          assert()
          if (source.hash !== expected) fail("Workspace target files disagree with the source frozen closure")
          for await (const captured of graph.workspaces()) {
            assert()
            await graph.verify(captured)
            const remote = selectedProvider.getStore()
            const selected = remote
              ? undefined
              : Native.parse(
                  await host().prepare({
                    handoffID: binding.handoffID,
                    captured,
                    store: graph.store(captured),
                    signal,
                  }),
                )
            assert()
            if (selected && selected.scopeID !== binding.scopeID)
              fail("Native Workspace target belongs to another Scope")
            const previous = await readWorkspace(binding.handoffID, captured.workspaceID)
            assert()
            if (previous?.native && digest(previous.native) !== digest(selected))
              fail("Native Workspace preparation changed")
            const now = previous?.catalog.createdAt ?? Date.now()
            const catalog = remote
              ? WorkspaceCatalog.Info.parse(
                  await provider(remote).prepare({ handoffID: binding.handoffID, captured, signal }),
                )
              : WorkspaceCatalog.Info.parse({
                  id: selected!.workspaceID,
                  scopeID: binding.scopeID,
                  type: "directory",
                  revision: 1,
                  binding: {
                    state: "bound",
                    hostID: selected!.hostID,
                    path: selected!.path,
                    physicalID: selected!.physicalID,
                    generation: 1,
                  },
                  backend: { provider: "directory", spec: {} },
                  metadata: {},
                  sharedWritableWorkspaceIDs: [],
                  lifecycle: "active",
                  createdAt: now,
                  updatedAt: now,
                })
            assert()
            if (
              catalog.scopeID !== binding.scopeID ||
              (remote &&
                (catalog.content ||
                  catalog.activeMount ||
                  catalog.binding.state !== "bound" ||
                  catalog.binding.path !== null ||
                  catalog.binding.physicalID ||
                  catalog.backend?.provider !== remote))
            )
              fail("Workspace provider preparation cannot carry local file authority")
            if (previous && digest(previous.catalog) !== digest(catalog)) fail("Workspace provider preparation changed")
            await Storage.write(
              workspaceKey(binding.handoffID, captured.workspaceID),
              Workspace.parse({
                version: 1,
                sourceWorkspaceID: captured.workspaceID,
                catalog,
                native: selected,
                provider: remote,
              }),
            )
          }
          for await (const sessionID of graph.memberIDs()) {
            for await (const reference of graph.references(sessionID)) {
              assert()
              const previous = await readWorkspace(binding.handoffID, reference.id)
              if (previous?.native || previous?.provider) continue
              const now = previous?.catalog.createdAt ?? Date.now()
              const catalog = WorkspaceCatalog.Info.parse({
                id: "wsp_" + digest([binding.handoffID, binding.scopeID, reference.id]),
                scopeID: binding.scopeID,
                type: "unknown",
                revision: 1,
                binding: {
                  state: "unbound",
                  hostID: "unknown",
                  path: null,
                  generation: Math.max(previous?.catalog.binding.generation ?? 1, reference.generation ?? 1),
                },
                metadata: {},
                sharedWritableWorkspaceIDs: [],
                lifecycle: "active",
                createdAt: now,
                updatedAt: now,
              })
              await Storage.write(
                workspaceKey(binding.handoffID, reference.id),
                Workspace.parse({ version: 1, sourceWorkspaceID: reference.id, catalog }),
              )
            }
          }
          const converted = createHash("sha256").update("synergy.workspace.target.v1\n" + source.hash + "\n")
          for await (const workspace of workspaces(binding.handoffID)) {
            assert()
            converted.update(JSON.stringify(workspace) + "\n")
          }
          const prepared = Prepared.parse({
            version: 1,
            binding,
            manifestHash: staging.rootHash,
            sourceReceiptHash: expected,
            hash: converted.digest("hex"),
          })
          for await (const sessionID of graph.memberIDs()) {
            const workspaceIDs: Record<string, string> = {}
            for await (const reference of graph.references(sessionID)) {
              const workspace = await readWorkspace(binding.handoffID, reference.id)
              assert()
              if (!workspace) fail("Portable Workspace mapping is absent")
              workspaceIDs[reference.id] = workspace.catalog.id
            }
            await Storage.write(
              mappingKey(binding.handoffID, sessionID),
              Mapping.parse({ workspaceIDs, workspaceReceiptHash: prepared.hash }),
            )
          }
          await Storage.transaction(
            async () => {
              assert()
              await Storage.write(preparedKey(binding.handoffID), prepared)
            },
            { commitGuard: assert },
          )
          assert()
          return prepared
        },
      )
    })
  }
  export function mapping(input: { handoffID: string; sessionID: string; signal: AbortSignal }) {
    const handoffID = ID.parse(input.handoffID)
    const sessionID = ID.parse(input.sessionID)
    const signal = input.signal
    const assert = ownership(signal)
    return withStorageQueueOptions({ signal }, async () => {
      const value = Mapping.parse(await Storage.read(mappingKey(handoffID, sessionID)))
      const prepared = Prepared.parse(await Storage.read(preparedKey(handoffID)))
      assert()
      if (value.workspaceReceiptHash !== prepared.hash) fail("Portable Workspace mapping has another preparation")
      return value
    })
  }
  export function withPublication<T>(input: { handoffID: string; signal: AbortSignal }, body: () => Promise<T>) {
    const handoffID = ID.parse(input.handoffID)
    const signal = input.signal
    const assert = ownership(signal)
    return withStorageQueueOptions({ signal }, async () => {
      Prepared.parse(await Storage.read(preparedKey(handoffID)))
      const values: Native[] = []
      const remote: WorkspaceCatalog.Info[] = []
      for await (const workspace of workspaces(handoffID)) {
        assert()
        if (workspace.native) values.push(workspace.native)
        if (workspace.provider) {
          provider(workspace.provider)
          remote.push(workspace.catalog)
        }
      }
      const publish = async () => {
        assert()
        const value = await body()
        assert()
        return value
      }
      if (remote.length) {
        if (values.length) fail("Workspace aggregate cannot mix publication providers")
        return provider().withPublication(remote, signal, publish)
      }
      return host().withPublication(values, signal, publish)
    })
  }
  export async function validate(context: Owners.TargetContext): Promise<void> {
    const assert = ownership(context.signal)
    const actual = Mapping.parse(context.mapping)
    const expected = await mapping({
      handoffID: context.handoffID,
      sessionID: context.session.id,
      signal: context.signal,
    })
    assert()
    if (digest(actual) !== digest(expected)) fail("Portable Workspace mapping changed")
    for (const sourceID of Object.keys(expected.workspaceIDs)) {
      const workspace = await readWorkspace(context.handoffID, sourceID)
      assert()
      if (!workspace || workspace.catalog.id !== expected.workspaceIDs[sourceID])
        fail("Portable Workspace mapping has no prepared identity")
      if (workspace.native) {
        await host().validate(workspace.native, context.signal)
        assert()
      }
      if (workspace.provider) {
        await provider(workspace.provider).validate(workspace.catalog, context.signal)
        assert()
      }
    }
  }
  export async function publish(context: Owners.TargetContext): Promise<void> {
    const activation = Epochs.assertActivation({ sessionID: context.session.id, handoffID: context.handoffID })
    const assert = ownership(context.signal)
    const prepared = Prepared.parse(await Storage.read(preparedKey(context.handoffID)))
    const expectedBinding = Epochs.Binding.parse({
      ...prepared.binding,
      sessionID: context.session.id,
      ...(context.session.id === context.rootSessionID ? {} : { rootSessionID: context.rootSessionID }),
    })
    const epoch = await Epochs.inspect(activation)
    assert()
    if (
      digest(activation) !== digest(expectedBinding) ||
      epoch.role !== "target" ||
      epoch.phase !== "prepared" ||
      epoch.manifestHash !== prepared.manifestHash
    )
      fail("Workspace publication requires its exact prepared destination epoch")
    const selected = Mapping.parse(context.mapping)
    const expected = await mapping({
      handoffID: context.handoffID,
      sessionID: context.session.id,
      signal: context.signal,
    })
    if (digest(selected) !== digest(expected)) fail("Portable Workspace publication has another mapping")
    for (const sourceID of Object.keys(expected.workspaceIDs)) {
      const workspace = await readWorkspace(context.handoffID, sourceID)
      assert()
      if (!workspace) fail("Portable Workspace publication is not prepared")
      const native = workspace.native
      const guard = () => {
        assert()
        if (native) host().assertPublication(native)
        if (workspace.provider) provider(workspace.provider).assertPublication(workspace.catalog)
      }
      guard()
      await Storage.transaction(
        async (tx) => {
          const [existing] = await tx.readMany([StoragePath.workspace(workspace.catalog.id)])
          if (existing !== undefined) {
            if (digest(WorkspaceCatalog.Info.parse(existing)) !== digest(workspace.catalog))
              fail("Prepared Workspace catalog identity was occupied")
          } else {
            if (native) await WorkspaceCatalog.writeRelocated(workspace.catalog, tx)
            else if (workspace.provider) await WorkspaceCatalog.writeImportedFiles(workspace.catalog, tx)
            else await WorkspaceCatalog.writeImported(workspace.catalog, tx)
            Storage.afterCommit(() => WorkspaceCatalog.publishUpdated(workspace.catalog))
          }
          if (native)
            await tx.write(["workspace_portable_target_published", workspace.catalog.id], {
              version: 1,
              handoffID: context.handoffID,
              sourceWorkspaceID: sourceID,
            })
        },
        { commitGuard: guard },
      )
    }
  }

  export async function ownsWorkspace(info: WorkspaceCatalog.Info, signal: AbortSignal): Promise<boolean> {
    const catalog = WorkspaceCatalog.Info.parse(info)
    const assert = ownership(signal)
    const [raw] = await Storage.readMany([["workspace_portable_target_published", catalog.id]])
    assert()
    if (raw === undefined) return false
    const published = z.strictObject({ version: z.literal(1), handoffID: ID, sourceWorkspaceID: ID }).parse(raw)
    const prepared = Prepared.parse(await Storage.read(preparedKey(published.handoffID)))
    const workspace = await readWorkspace(published.handoffID, published.sourceWorkspaceID)
    const epoch = await Epochs.inspect(prepared.binding)
    const current = await WorkspaceCatalog.get(catalog.id, catalog.scopeID)
    assert()
    return (
      current.lifecycle === "active" &&
      current.binding.state === "bound" &&
      current.revision === catalog.revision &&
      digest(current.binding) === digest(catalog.binding) &&
      epoch.role === "target" &&
      epoch.phase === "activated" &&
      epoch.manifestHash === prepared.manifestHash &&
      !!workspace?.native &&
      workspace.catalog.id === catalog.id &&
      workspace.catalog.scopeID === catalog.scopeID &&
      workspace.catalog.binding.hostID === catalog.binding.hostID &&
      workspace.catalog.binding.path === catalog.binding.path &&
      workspace.catalog.binding.physicalID === catalog.binding.physicalID
    )
  }
}
