import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { BusEvent } from "../bus/bus-event"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import type { Workspace } from "../session/workspace-schema"
import type { StoreTransaction } from "../storage/transactional-store"

export namespace WorkspaceCatalog {
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
    const [record] = await (transaction ?? Storage).readMany<unknown>([recordKey(id)])
    const info = record === undefined ? undefined : Info.parse(record)
    if (!info || info.scopeID !== scopeID)
      throw new Storage.NotFoundError({ message: "Workspace not found in this Scope" })
    return info
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
      metadata: input.metadata ?? {},
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    return Storage.transaction(async () => {
      const ids = await Storage.readMany<string>(locations(candidate))
      const matches = [...new Set(ids.filter((id): id is string => !!id))]
      if (matches.length > 1)
        throw new Unavailable({ message: "Workspace location has conflicting registrations", workspaceID: matches[0] })
      if (matches[0]) {
        const existing = await get(matches[0], input.scopeID)
        if (existing.lifecycle !== "active")
          throw new Unavailable({ message: "Workspace is being removed", workspaceID: existing.id })
        if (existing.binding.physicalID && input.physicalID && existing.binding.physicalID !== input.physicalID)
          throw new Unavailable({
            message: "The directory was replaced; explicitly rebind this Workspace",
            workspaceID: existing.id,
          })
        return existing
      }
      await Storage.write(recordKey(candidate.id), candidate)
      await Storage.write(scopeKey(candidate.scopeID, candidate.id), candidate.id)
      for (const key of locations(candidate)) await Storage.write(key, candidate.id)
      return candidate
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
      importedFrom: source.importedFrom ?? { workspaceID: source.id, hostID: source.binding.hostID },
      sharedWritableWorkspaceIDs: [],
      lifecycle: "active",
    })
  }

  export async function writeImported(info: Info, tx: StoreTransaction) {
    if (info.binding.state !== "unbound" || info.sharedWritableWorkspaceIDs.length)
      throw new Invalid({ message: "Imported Workspace cannot carry local authority", workspaceID: info.id })
    if ((await tx.readMany([recordKey(info.id)]))[0] !== undefined)
      throw new BindingChanged({ message: "Workspace identity was occupied during import", workspaceID: info.id })
    await tx.write(recordKey(info.id), info)
    await tx.write(scopeKey(info.scopeID, info.id), info.id)
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
