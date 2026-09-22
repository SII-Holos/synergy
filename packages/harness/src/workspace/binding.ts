import path from "node:path"
import { randomUUID } from "node:crypto"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceCatalog } from "./catalog"
import { Storage } from "../storage/storage"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Bus } from "../bus"
import { WorkspaceAccess } from "./access"
import { WorkspaceLocation } from "./location"
import type { Workspace } from "../session/workspace-schema"

export namespace WorkspaceBinding {
  export async function register(scopeID: string, directory: string): Promise<WorkspaceCatalog.Info> {
    if (!path.isAbsolute(directory)) throw new Error("Workspace location must be absolute")
    const source = WorkspaceLocation.source()
    const location = await source.identify(directory)
    const hostID = await source.hostID()
    return publishChange(scopeID, () => WorkspaceCatalog.register({ scopeID, type: "directory", hostID, ...location }))
  }

  export async function importHistory(
    workspace: Workspace,
    scopeID: string,
    record?: WorkspaceCatalog.Info,
  ): Promise<Workspace> {
    if (workspace.scopeID !== scopeID || (record && record.scopeID !== scopeID))
      throw new Error("Workspace belongs to a different Scope")
    const { path: location, scopeID: _scope, type, id, generation, ...metadata } = workspace
    const imported = await WorkspaceCatalog.importRecord(
      record
        ? { ...record, binding: { ...record.binding, path: record.binding.path ?? location } }
        : {
            id: id ?? `wsp_${randomUUID().replaceAll("-", "")}`,
            scopeID,
            type,
            revision: 1,
            metadata,
            binding: { state: "unbound", hostID: "unknown", path: location, generation: generation ?? 1 },
            sharedWritableWorkspaceIDs: [],
            lifecycle: "active",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
    )
    return WorkspaceCatalog.projection(imported)!
  }

  export async function migrate(workspace: Workspace | null, scopeID: string): Promise<Workspace | null> {
    if (!workspace) return null
    return RuntimeContext.current().host.workspaceLocation
      ? adopt(workspace, scopeID)
      : importHistory(workspace, scopeID)
  }

  export async function adopt(workspace: Workspace | null, scopeID: string): Promise<Workspace | null> {
    if (!workspace) return null
    if (workspace.scopeID !== scopeID) throw new Error("Workspace belongs to a different Scope")
    if (workspace.id?.startsWith("wsp_"))
      return WorkspaceCatalog.projection(await WorkspaceCatalog.get(workspace.id, scopeID))
    if (!path.isAbsolute(workspace.path)) throw new Error("Workspace location must be absolute")
    const source = WorkspaceLocation.source()
    const hostID = await source.hostID()
    const location = await source.identify(workspace.path, true)
    const { path: _path, scopeID: _scope, type, id: _id, generation: _generation, ...metadata } = workspace
    const info = await WorkspaceCatalog.register({ scopeID, type, hostID, ...location, metadata })
    return WorkspaceCatalog.projection(info)
  }

  export async function writableRoots(workspace: Workspace): Promise<string[]> {
    if (!workspace.id) return [workspace.path]
    const own = await validate(workspace.id, workspace.scopeID, workspace.generation)
    const record = await WorkspaceCatalog.get(workspace.id, workspace.scopeID)
    const shared = await Promise.all(record.sharedWritableWorkspaceIDs.map((id) => validate(id, workspace.scopeID)))
    await WorkspaceAccess.use(shared)
    return [...new Set([own.path, ...shared.map((target) => target.path)])]
  }

  export async function setSharing(
    id: string,
    input: { scopeID: string; expectedRevision: number; workspaceIDs: string[] },
    signal?: AbortSignal,
  ): Promise<WorkspaceCatalog.Info> {
    const own = await validate(id, input.scopeID)
    return WorkspaceAccess.exclusive(
      [own.path],
      async () => {
        await validate(id, input.scopeID, own.generation)
        await Promise.all(input.workspaceIDs.map((target) => validate(target, input.scopeID)))
        return publishChange(input.scopeID, () => WorkspaceCatalog.setSharing(id, input))
      },
      signal,
    )
  }

  export async function rebind(
    id: string,
    input: { scopeID: string; expectedRevision: number; path: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceCatalog.Info> {
    if (!path.isAbsolute(input.path))
      throw new WorkspaceCatalog.Invalid({ message: "Workspace location must be absolute", workspaceID: id })
    const previous = await WorkspaceCatalog.get(id, input.scopeID)
    const source = WorkspaceLocation.source()
    const hostID = await source.hostID()
    const target = await source.identify(input.path)
    const roots = [
      target.path,
      ...(previous.binding.state === "bound" && previous.binding.hostID === hostID && previous.binding.path
        ? [previous.binding.path]
        : []),
    ]
    return WorkspaceAccess.exclusive(
      roots,
      async () => {
        const currentTarget = await source.identify(input.path)
        if (currentTarget.path !== target.path || currentTarget.physicalID !== target.physicalID)
          throw new WorkspaceCatalog.BindingChanged({
            message: "Workspace destination changed during rebinding",
            workspaceID: id,
          })
        const current = await WorkspaceCatalog.get(id, input.scopeID)
        if (current.revision !== input.expectedRevision)
          throw new WorkspaceCatalog.BindingChanged({ message: "Workspace changed before rebinding", workspaceID: id })
        const { WorkspaceRuntime } = await import("./runtime")
        await WorkspaceRuntime.disposeWorkspace(id)
        return publishChange(input.scopeID, () => WorkspaceCatalog.rebind(id, { ...input, hostID, ...target }))
      },
      signal,
    )
  }

  async function publishChange(scopeID: string, fn: () => Promise<WorkspaceCatalog.Info>) {
    const scope = await Scope.resolve({ scopeID })
    return ScopeContext.provide({
      scope,
      workspace: null,
      fn: () =>
        Storage.transaction(async () => {
          const record = await fn()
          await Bus.publish(WorkspaceCatalog.Event.Updated, record)
          return record
        }),
    })
  }

  export async function validate(workspaceID: string, scopeID: string, generation?: number): Promise<Workspace> {
    const source = WorkspaceLocation.source()
    const info = await WorkspaceCatalog.resolve(workspaceID, { scopeID, hostID: await source.hostID(), generation })
    const actual = await source.identify(info.binding.path).catch(() => {
      throw new WorkspaceCatalog.Unavailable({ message: "The Workspace directory is unavailable", workspaceID })
    })
    if (info.binding.physicalID && actual.physicalID !== info.binding.physicalID)
      throw new WorkspaceCatalog.Unavailable({
        message: "The Workspace directory was replaced; rebind it before executing",
        workspaceID,
      })
    return WorkspaceCatalog.projection(info)
  }
}
