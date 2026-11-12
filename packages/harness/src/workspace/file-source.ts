import { createHash } from "node:crypto"
import { z } from "zod"
import { JsonValue } from "../util/json-value"
import { RuntimeContext } from "../lifecycle/context"
import { EnvironmentOrigin } from "../environment/origin"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceContent } from "./content"
import { WorkspaceProtocol, type WorkspaceFileHost } from "./protocol"
import { WorkspaceTree } from "./tree"
import { WorkspaceErrors } from "./errors"

export namespace WorkspaceFileSource {
  export class Rejected extends Error {
    readonly failure: WorkspaceErrors.Failure
    constructor(failure: WorkspaceErrors.Failure) {
      const parsed = WorkspaceErrors.Failure.parse(failure)
      super(parsed.message)
      this.name = "WorkspaceFileSourceRejected"
      this.failure = parsed
    }
  }
  export const Record = z.strictObject({
    version: z.literal(1),
    provider: z.string().min(1),
    backendHash: z.string().regex(/^[a-f0-9]{64}$/),
    binding: JsonValue,
  })
  export type Record = z.infer<typeof Record>
  export type Input = { workspace: Readonly<WorkspaceCatalog.Info>; signal?: AbortSignal } & (
    { origin: EnvironmentOrigin.Captured; binding?: never } | { binding: unknown; origin?: never }
  )
  export interface Lease {
    files: WorkspaceFileHost
    reference: WorkspaceProtocol.Reference
    directory: string
    binding: unknown
    assert(): void
    release(): Promise<void>
  }
  export interface Provider {
    open(input: Input): Promise<Lease>
  }
  interface Frame {
    workspace: WorkspaceCatalog.Info
    record: Record
    assert(): void
    inspection: boolean
  }
  const providers = RuntimeContext.state(() => new Map<string, Provider>())
  const leases = new WeakMap<Lease, Frame>()
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  function unavailable(workspaceID: string, message: string): never {
    throw new WorkspaceCatalog.Unavailable({ workspaceID, message })
  }
  export function register(id: string, provider: Provider) {
    RuntimeContext.assertCompositionOpen("Workspace file sources")
    id = Record.shape.provider.parse(id)
    if (id === "objects" || id === "directory" || providers().has(id))
      throw new Error("Workspace file source is canonical or already registered")
    providers().set(id, { open: provider.open.bind(provider) })
  }
  export function has(id: string) {
    return providers().has(id)
  }
  export function capture(lease: Lease, workspace: WorkspaceCatalog.Info): Record {
    const frame = leases.get(lease)
    if (!frame || frame.inspection) unavailable(workspace.id, "Workspace writes require their original access lease")
    assertSelection(lease, workspace)
    return Record.parse(structuredClone(frame.record))
  }
  export function assertSelection(lease: Lease, workspace: WorkspaceCatalog.Info) {
    const frame = leases.get(lease)
    if (!frame) unavailable(workspace.id, "Workspace files require their original lease")
    frame.assert()
    if (
      workspace.id !== frame.workspace.id ||
      workspace.scopeID !== frame.workspace.scopeID ||
      workspace.binding.generation !== frame.workspace.binding.generation ||
      hash(workspace.backend) !== frame.record.backendHash
    )
      unavailable(workspace.id, "Workspace file source belongs to another original binding")
  }
  export async function restore(record: Record, workspace: WorkspaceCatalog.Info, signal?: AbortSignal) {
    const saved = Record.parse(structuredClone(record))
    if (saved.provider !== workspace.backend?.provider || saved.backendHash !== hash(workspace.backend))
      unavailable(workspace.id, "Workspace receipt belongs to another original backend")
    return open({ workspace, signal, binding: saved.binding })
  }
  export async function open(input: Input): Promise<Lease> {
    input = { ...input, workspace: WorkspaceCatalog.Info.parse(structuredClone(input.workspace)) }
    const workspace = WorkspaceCatalog.Info.parse(structuredClone(input.workspace))
    const signal = input.signal
    const origin = input.origin
    const provider = workspace.backend && providers().get(workspace.backend.provider)
    if (!provider) unavailable(workspace.id, "Workspace file source is unavailable")
    if (workspace.lifecycle !== "active" || workspace.binding.state !== "bound" || workspace.activeMount)
      unavailable(workspace.id, "Workspace files require their dormant active binding")
    const owner = WorkspaceContent.captureOwner()
    const inspection = input.binding !== undefined
    if (!inspection) {
      if (!origin) unavailable(workspace.id, "Workspace files require their original resource origin")
      await RuntimeMaintenance.assertAdmission()
      await EnvironmentOrigin.assertAdmission(origin, { scopeID: workspace.scopeID })
    }
    owner()
    signal?.throwIfAborted()
    const native = await provider.open(input)
    let open = true
    let closing: Promise<void> | undefined
    const pending = new Set<Promise<unknown>>()
    const assert = () => {
      owner()
      signal?.throwIfAborted()
      if (!open) unavailable(workspace.id, "Workspace file lease has ended")
      native.assert()
    }
    const release = () =>
      (closing ??= (async () => {
        owner()
        open = false
        await Promise.allSettled(pending)
        await native.release()
        owner()
      })())
    try {
      assert()
      const reference = WorkspaceProtocol.Reference.parse(native.reference)
      if (
        reference.id !== workspace.id ||
        reference.workspaceID !== workspace.id ||
        reference.generation !== workspace.binding.generation
      )
        unavailable(workspace.id, "Workspace file handle differs from its logical binding")
      const record = Record.parse({
        version: 1,
        provider: workspace.backend!.provider,
        backendHash: hash(workspace.backend),
        binding: structuredClone(native.binding),
      })
      const latest = await WorkspaceCatalog.get(workspace.id, workspace.scopeID)
      if (
        latest.lifecycle !== "active" ||
        latest.binding.state !== "bound" ||
        latest.activeMount ||
        latest.binding.generation !== workspace.binding.generation ||
        hash(latest.backend) !== record.backendHash
      )
        unavailable(workspace.id, "Workspace file binding changed during opening")
      assert()
      const directory = WorkspaceTree.VirtualRoot.parse(native.directory)
      async function perform<T>(body: () => Promise<T>, effect = false): Promise<T> {
        assert()
        if (inspection && effect) unavailable(workspace.id, "Recovered file leases only inspect original receipts")
        const work = Promise.resolve().then(async () => {
          assert()
          const result = await body()
          assert()
          return result
        })
        pending.add(work)
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        )
        return work
      }
      const files: WorkspaceFileHost = {
        mount: (value) => perform(() => native.files.mount(value), true),
        inspect: (value) => perform(() => native.files.inspect(value), true),
        detach: (value) => perform(() => native.files.detach(value), true),
        canonical: (value, path, follow) => perform(() => native.files.canonical(value, path, follow), true),
        stat: (value, path, follow) => perform(() => native.files.stat(value, path, follow), true),
        list: (value, path) => perform(() => native.files.list(value, path), true),
        read: (value) => perform(() => native.files.read(value), true),
        write: (value) => perform(() => native.files.write(value), true),
        mutate: (value) => perform(() => native.files.mutate(value), true),
        checkpoint: (value) => perform(() => native.files.checkpoint(value), true),
        checkpointStatus: (id) => perform(() => native.files.checkpointStatus(id)),
        acknowledge: (id) => perform(() => native.files.acknowledge(id)),
        putBlob: (id, bytes) => perform(() => native.files.putBlob(id, bytes), true),
        getBlob: (id, maximum) => perform(() => native.files.getBlob(id, maximum), true),
        ...(native.files.observe
          ? {
              observe: (value: WorkspaceProtocol.Reference, signal?: AbortSignal) =>
                perform(() => native.files.observe!(value, signal), true),
            }
          : {}),
      }
      const lease: Lease = Object.freeze({
        files,
        reference: Object.freeze(reference),
        directory,
        binding: structuredClone(record.binding),
        assert,
        release,
      })
      leases.set(lease, { workspace, record, assert, inspection })
      return lease
    } catch (error) {
      await release()
      throw error
    }
  }
}
