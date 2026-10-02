import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import type { Workspace } from "../session/workspace-schema"
import type { StoreTransaction } from "../storage/transactional-store"
import { WorkspaceTree } from "./tree"
import { EnvironmentSchema } from "../environment/schema"
import { JsonValue } from "../util/json-value"

export namespace WorkspaceCatalog {
  export const Backend = z.object({ provider: z.string().min(1), spec: z.record(z.string(), JsonValue) })
  export const Content = z.object({ revision: z.number().int().nonnegative(), manifest: WorkspaceTree.Hash.nullable() })
  export const Mount = z.object({
    id: z.string(),
    generation: z.number().int().positive(),
    target: EnvironmentSchema.Target,
    path: z.string(),
    state: z.enum(["preparing", "active", "saving", "unavailable"]),
    readOnly: z.boolean().default(false),
  })
  export const Binding = z.object({
    state: z.enum(["bound", "unbound"]),
    hostID: z.string().min(1),
    path: z.string().min(1).nullable(),
    physicalID: z.string().optional(),
    generation: z.number().int().positive(),
  })
  export const Info = z
    .object({
      id: z.string().min(1),
      scopeID: z.string().min(1),
      type: z.string().min(1),
      revision: z.number().int().positive(),
      binding: Binding,
      backend: Backend.optional(),
      content: Content.optional(),
      mountGeneration: z.number().int().nonnegative().optional(),
      activeMount: Mount.optional(),
      importedFrom: z.object({ workspaceID: z.string(), hostID: z.string() }).optional(),
      metadata: z.record(z.string(), z.unknown()),
      sharedWritableWorkspaceIDs: z.array(z.string()),
      lifecycle: z.enum(["active", "deleting", "deleted"]),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .passthrough()
    .meta({ ref: "WorkspaceInfo" })
  export type Info = z.infer<typeof Info>
  export const Event = { Updated: BusEvent.define("workspace.updated", Info) }
  export async function publishUpdated(info: Info) {
    const scope = await Scope.fromID(info.scopeID)
    if (!scope) return
    await ScopeContext.provide({ scope, workspace: null, fn: () => Bus.publish(Event.Updated, info) })
  }
  export const Invalid = NamedError.create(
    "WorkspaceInvalid",
    z.object({ message: z.string(), workspaceID: z.string() }),
  )
  export const BindingChanged = NamedError.create(
    "WorkspaceBindingChanged",
    z.object({ message: z.string(), workspaceID: z.string() }),
  )
  export const Unavailable = NamedError.create(
    "WorkspaceUnavailable",
    z.object({ message: z.string(), workspaceID: z.string() }),
  )

  export interface RegisterInput {
    scopeID: string
    type: string
    hostID: string
    path: string
    physicalID?: string
    metadata?: Record<string, unknown>
  }

  const recordKey = StoragePath.workspace
  const scopeKey = StoragePath.workspaceScope
  const locationKey = (scopeID: string, hostID: string, value: string) =>
    StoragePath.workspaceLocation(scopeID, hostID, createHash("sha256").update(value).digest("hex"))
  const locations = (info: Pick<Info, "scopeID" | "binding">) => [
    locationKey(info.scopeID, info.binding.hostID, `path:${info.binding.path}`),
    ...(info.binding.physicalID
      ? [locationKey(info.scopeID, info.binding.hostID, `file:${info.binding.physicalID}`)]
      : []),
  ]

  export async function get(
    id: string,
    scopeID: string,
    transaction?: Pick<StoreTransaction, "readMany">,
  ): Promise<Info> {
    const [info] = await readMany([id], transaction)
    if (!info || info.scopeID !== scopeID)
      throw new Storage.NotFoundError({ message: "Workspace not found in this Scope" })
    return info
  }

  export async function readMany(ids: string[], transaction?: Pick<StoreTransaction, "readMany">) {
    const records = await (transaction ?? Storage).readMany<unknown>(ids.map(recordKey))
    return records.map((record) => (record === undefined ? undefined : Info.parse(record)))
  }

  export async function list(scopeID: string): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.workspaceScope(scopeID))
    const records = await Storage.readMany<unknown>(keys.map((key) => recordKey(key[2])))
    return records.flatMap((record) => (record === undefined ? [] : [Info.parse(record)]))
  }

  export async function register(input: RegisterInput): Promise<Info> {
    const candidate = Info.parse({
      id: `wsp_${randomUUID().replaceAll("-", "")}`,
      scopeID: input.scopeID,
      type: input.type,
      revision: 1,
      binding: { state: "bound", hostID: input.hostID, path: input.path, physicalID: input.physicalID, generation: 1 },
      backend: { provider: "directory", spec: {} },
      content: { revision: 0, manifest: null },
      metadata: input.metadata ?? {},
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const registered = await Storage.snapshot(() => findRegistration(candidate))
    if (registered) return registered
    return Storage.transaction(async () => {
      const existing = await findRegistration(candidate)
      if (existing) return existing
      await Storage.write(recordKey(candidate.id), candidate)
      await Storage.write(scopeKey(candidate.scopeID, candidate.id), candidate.id)
      for (const key of locations(candidate)) await Storage.write(key, candidate.id)
      return candidate
    })
  }

  async function findRegistration(candidate: Info): Promise<Info | undefined> {
    const ids = await Storage.readMany<string>(locations(candidate))
    const matches = [...new Set(ids.filter((id): id is string => !!id))]
    if (matches.length > 1)
      throw new Unavailable({ message: "Workspace location has conflicting registrations", workspaceID: matches[0] })
    if (!matches[0]) return
    const existing = await get(matches[0], candidate.scopeID)
    if (existing.lifecycle !== "active")
      throw new Unavailable({ message: "Workspace is being removed", workspaceID: existing.id })
    if (
      existing.binding.physicalID &&
      candidate.binding.physicalID &&
      existing.binding.physicalID !== candidate.binding.physicalID
    )
      throw new Unavailable({
        message: "The directory was replaced; explicitly rebind this Workspace",
        workspaceID: existing.id,
      })
    return existing
  }

  export async function create(input: {
    scopeID: string
    backend: z.infer<typeof Backend>
    metadata?: Record<string, unknown>
  }): Promise<Info> {
    const info = Info.parse({
      id: `wsp_${randomUUID().replaceAll("-", "")}`,
      scopeID: input.scopeID,
      type: input.backend.provider,
      revision: 1,
      binding: { state: "bound", hostID: "provider", path: null, generation: 1 },
      backend: input.backend,
      content: { revision: 0, manifest: null },
      metadata: input.metadata ?? {},
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return Storage.transaction(async () => {
      await Storage.write(recordKey(info.id), info)
      await Storage.write(scopeKey(info.scopeID, info.id), info.id)
      await publishUpdated(info)
      return info
    })
  }

  export async function publishContent(previous: Info, manifest: string): Promise<Info> {
    WorkspaceTree.Hash.parse(manifest)
    return Storage.transaction(async () => {
      const latest = await get(previous.id, previous.scopeID)
      if (latest.lifecycle !== "active" || latest.binding.state !== "bound")
        throw new Unavailable({ workspaceID: latest.id, message: "Workspace has no active storage authority" })
      if (
        latest.binding.generation !== previous.binding.generation ||
        latest.content?.revision !== previous.content?.revision ||
        latest.activeMount?.id !== previous.activeMount?.id ||
        latest.activeMount?.generation !== previous.activeMount?.generation ||
        (latest.activeMount &&
          previous.activeMount &&
          !EnvironmentSchema.sameTarget(latest.activeMount.target, previous.activeMount.target))
      )
        throw new BindingChanged({ workspaceID: latest.id, message: "Workspace changed before checkpoint publication" })
      if (latest.activeMount) {
        const [value] = await Storage.readMany<unknown>([
          StoragePath.environment(latest.activeMount.target.environmentID),
        ])
        const environment = EnvironmentSchema.Info.parse(value)
        if (
          environment.scopeID !== latest.scopeID ||
          !["ready", "releasing"].includes(environment.state) ||
          environment.allocation?.id !== latest.activeMount.target.allocationID ||
          environment.generation !== latest.activeMount.target.generation
        )
          throw new BindingChanged({
            workspaceID: latest.id,
            message: "Workspace allocation changed before checkpoint publication",
          })
      }
      const next = Info.parse({
        ...latest,
        revision: latest.revision + 1,
        content: { revision: (latest.content?.revision ?? 0) + 1, manifest },
        updatedAt: Date.now(),
      })
      await Storage.write(StoragePath.workspaceContent(next.id, next.content!.revision), {
        ...next.content,
        workspaceID: next.id,
        scopeID: next.scopeID,
        generation: next.binding.generation,
        createdAt: next.updatedAt,
      })
      await Storage.write(recordKey(next.id), next)
      await publishUpdated(next)
      return next
    })
  }

  export function importMissingReference(id: string, scopeID: string): Promise<Info> {
    return importRecord({
      id,
      scopeID,
      type: "unknown",
      revision: 1,
      binding: { state: "unbound", hostID: "unknown", path: null, generation: 1 },
      metadata: {},
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  export async function importRecord(record: Info): Promise<Info> {
    const source = Info.parse(record)
    return Storage.transaction(async (tx) => {
      const [existing] = await Storage.readMany<Info>([recordKey(source.id)])
      if (
        existing?.scopeID === source.scopeID &&
        existing.binding.state === "unbound" &&
        existing.binding.hostID === source.binding.hostID &&
        existing.binding.path === source.binding.path
      )
        return Info.parse(existing)
      const imported = forImport(
        source,
        existing || !source.id.startsWith("wsp_") ? `wsp_${randomUUID().replaceAll("-", "")}` : source.id,
      )
      await writeImported(imported, tx)
      return imported
    })
  }

  export function forImport(source: Info, id: string): Info {
    return Info.parse({
      ...source,
      id,
      binding: { ...source.binding, state: "unbound" },
      activeMount: undefined,
      mountGeneration: undefined,
      importedFrom: source.importedFrom ?? { workspaceID: source.id, hostID: source.binding.hostID },
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
    })
  }

  export async function writeImported(info: Info, tx: StoreTransaction) {
    if (info.binding.state !== "unbound" || info.sharedWritableWorkspaceIDs.length || info.activeMount)
      throw new Invalid({ message: "Imported Workspace cannot carry local authority", workspaceID: info.id })
    if ((await tx.readMany([recordKey(info.id)]))[0] !== undefined)
      throw new BindingChanged({ message: "Workspace identity was occupied during import", workspaceID: info.id })
    await tx.write(recordKey(info.id), info)
    await tx.write(scopeKey(info.scopeID, info.id), info.id)
  }

  export async function writeRelocated(info: Info, tx: StoreTransaction) {
    if (info.binding.state !== "bound" || !info.binding.path || !info.binding.physicalID || info.lifecycle !== "active")
      throw new Invalid({ message: "Relocated Workspace requires verified local authority", workspaceID: info.id })
    const keys = locations(info)
    if ((await tx.readMany([recordKey(info.id), ...keys])).some((value) => value !== undefined))
      throw new BindingChanged({
        message: "Workspace destination was occupied during relocation",
        workspaceID: info.id,
      })
    await tx.write(recordKey(info.id), info)
    await tx.write(scopeKey(info.scopeID, info.id), info.id)
    for (const key of keys) await tx.write(key, info.id)
  }

  export async function resolve(
    id: string,
    input: { scopeID: string; hostID: string; generation?: number },
  ): Promise<Info & { binding: { path: string } }> {
    const info = await get(id, input.scopeID)
    if (
      info.lifecycle !== "active" ||
      info.binding.state !== "bound" ||
      info.binding.hostID !== input.hostID ||
      !info.binding.path
    )
      throw new Unavailable({ message: "Workspace has no active binding on this host", workspaceID: id })
    if (input.generation !== undefined && info.binding.generation !== input.generation)
      throw new BindingChanged({ message: "Workspace binding changed; refresh before continuing", workspaceID: id })
    return { ...info, binding: { ...info.binding, path: info.binding.path } }
  }

  export async function rebind(
    id: string,
    input: {
      scopeID: string
      expectedRevision: number
      hostID: string
      path: string
      physicalID?: string
    },
  ): Promise<Info> {
    return Storage.transaction(async () => {
      const previous = await get(id, input.scopeID)
      if (previous.activeMount)
        throw new Unavailable({ workspaceID: id, message: "Detach the active Workspace mount before rebinding" })
      if (previous.revision !== input.expectedRevision)
        throw new BindingChanged({ message: "Workspace changed before rebinding", workspaceID: id })
      if (previous.lifecycle !== "active")
        throw new Unavailable({ message: "Workspace is not active", workspaceID: id })
      const next = Info.parse({
        ...previous,
        revision: previous.revision + 1,
        updatedAt: Date.now(),
        binding: {
          state: "bound",
          hostID: input.hostID,
          path: input.path,
          physicalID: input.physicalID,
          generation: previous.binding.generation + 1,
        },
        backend: { provider: "directory", spec: {} },
        activeMount: undefined,
      })
      const keys = locations(next)
      const conflicts = await Storage.readMany<string>(keys)
      if (conflicts.some((value) => value !== undefined && value !== id))
        throw new BindingChanged({ message: "The destination already belongs to another Workspace", workspaceID: id })
      if (previous.binding.state === "bound") for (const key of locations(previous)) await Storage.remove(key)
      await Storage.write(recordKey(id), next)
      for (const key of keys) await Storage.write(key, id)
      return next
    })
  }

  export async function setSharing(
    id: string,
    input: { scopeID: string; expectedRevision: number; workspaceIDs: string[] },
  ): Promise<Info> {
    return Storage.transaction(async () => {
      const previous = await get(id, input.scopeID)
      if (previous.revision !== input.expectedRevision)
        throw new BindingChanged({ message: "Workspace changed before sharing", workspaceID: id })
      if (previous.lifecycle !== "active" || previous.binding.state !== "bound")
        throw new Unavailable({ message: "Workspace has no active local binding", workspaceID: id })
      const workspaceIDs = [...new Set(input.workspaceIDs)]
      if (workspaceIDs.length > 64)
        throw new Invalid({ message: "At most 64 shared Workspaces are allowed", workspaceID: id })
      if (workspaceIDs.includes(id))
        throw new Invalid({ message: "A Workspace cannot share with itself", workspaceID: id })
      for (const targetID of workspaceIDs) {
        const target = await get(targetID, input.scopeID)
        if (
          target.lifecycle !== "active" ||
          target.binding.state !== "bound" ||
          target.binding.hostID !== previous.binding.hostID
        )
          throw new Unavailable({
            message: "Shared Workspace has no active binding on this host",
            workspaceID: targetID,
          })
      }
      const next = Info.parse({
        ...previous,
        sharedWritableWorkspaceIDs: workspaceIDs,
        revision: previous.revision + 1,
        updatedAt: Date.now(),
      })
      await Storage.write(recordKey(id), next)
      return next
    })
  }

  export function projection(info: Info & { binding: { path: string } }): Workspace
  export function projection(info: Info): Workspace | null
  export function projection(info: Info): Workspace | null {
    if (!info.binding.path) return null
    return {
      ...info.metadata,
      id: info.id,
      scopeID: info.scopeID,
      type: info.type,
      path: info.binding.path,
      generation: info.binding.generation,
      bindingState: info.binding.state,
      lifecycle: info.lifecycle,
    }
  }
}
