import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTransfer } from "@ericsanchezok/synergy-harness/session/workspace-transfer"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import type { StoreTransaction, TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { ScopeTransfer } from "@ericsanchezok/synergy-harness/scope/transfer"
import { ChannelWorkspaceTransfer } from "@ericsanchezok/synergy-connections/channel/workspace-transfer"
import { createLocalHost } from "@ericsanchezok/synergy-runtime-local/host"
import { WorktreeRelocation } from "@ericsanchezok/synergy-runtime-local/workspace/relocation"

export namespace WorkspaceHomeTransfer {
  export const roots = new Set(["workspace", "workspace_scope", "workspace_location"])

  function record(
    key: string[],
    value: unknown,
    resolve: WorkspaceTransfer.Resolve,
    relocate?: ScopeTransfer.Relocate,
  ) {
    if (relocate && key.length === 2 && key[0] === "projects") return ScopeTransfer.paths(value, relocate)
    if (key[0] === "channel") return ChannelWorkspaceTransfer.record(key, value, resolve, relocate)
    if (key.length === 4 && key[0] === "agenda" && key[1] === "items")
      return AgendaStore.transferWorkspace(value, resolve, relocate)
    return WorkspaceTransfer.record(key, value, resolve, relocate)
  }

  async function catalog(store: TransactionalStore) {
    const ids = await store.scan(["workspace"])
    const result = new Map<string, WorkspaceCatalog.Info>()
    for (let offset = 0; offset < ids.length; offset += 256) {
      const entries = await store.readMany(ids.slice(offset, offset + 256).map(StoragePath.workspace))
      for (const entry of entries) {
        const info = WorkspaceCatalog.Info.parse(entry)
        result.set(info.id, info)
      }
    }
    return result
  }

  export async function prepare(
    source: TransactionalStore,
    target: TransactionalStore,
    accept: (key: string[]) => boolean,
    move?: { sourceRoot: string; targetRoot: string },
  ) {
    const [incoming, existing] = await Promise.all([catalog(source), catalog(target)])
    const relocation = move ? await prepareRelocation(move) : undefined
    const references = new Map<string, WorkspaceTransfer.Reference>()
    const collect: WorkspaceTransfer.Resolve = (reference) => {
      const previous = references.get(reference.id)
      if (previous && previous.scopeID !== reference.scopeID)
        throw new Error("Workspace reference crosses imported Scopes")
      references.set(reference.id, {
        ...previous,
        ...reference,
        legacy: reference.legacy ? { ...previous?.legacy, ...reference.legacy } : previous?.legacy,
      })
      return reference.id
    }
    for (const workspace of incoming.values()) collect({ id: workspace.id, scopeID: workspace.scopeID })
    await source.snapshot(async (tx) => {
      for await (const entry of tx.records()) if (accept(entry.key)) record(entry.key, entry.value, collect)
    })
    const ids = new Map<string, string>()
    const imported: WorkspaceCatalog.Info[] = []
    const originals = new Map<string, WorkspaceCatalog.Info>()
    const identity = (info: WorkspaceCatalog.Info) =>
      JSON.stringify([
        info.scopeID,
        info.importedFrom?.workspaceID ?? info.id,
        info.importedFrom?.hostID ?? info.binding.hostID,
        info.binding.hostID,
        info.binding.path,
        info.binding.generation,
      ])
    const reusable = new Map(
      [...existing.values()]
        .filter((info) => info.lifecycle === "active" && info.binding.state === "unbound")
        .map((info) => [identity(info), info]),
    )
    for (const reference of references.values()) {
      const { legacy } = reference
      const historical =
        incoming.get(reference.id) ??
        WorkspaceCatalog.Info.parse({
          id: reference.id,
          scopeID: reference.scopeID,
          type: legacy?.type ?? "unknown",
          revision: 1,
          binding: {
            state: "unbound",
            hostID: "unknown",
            path: legacy?.path ?? null,
            generation: legacy?.generation ?? 1,
          },
          metadata: legacy ?? {},
          sharedWritableWorkspaceIDs: [],
          lifecycle: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      if (historical.scopeID !== reference.scopeID)
        throw new Error("Workspace metadata belongs to another imported Scope")
      const binding = await relocation?.binding(historical)
      const occupied = binding
        ? [...existing.values(), ...imported].find(
            (info) =>
              info.scopeID === historical.scopeID &&
              info.binding.state === "bound" &&
              info.binding.hostID === binding.hostID &&
              (info.binding.path === binding.path || info.binding.physicalID === binding.physicalID),
          )
        : undefined
      if (occupied) {
        if (occupied.lifecycle !== "active" || occupied.binding.physicalID !== binding!.physicalID)
          throw new Error("Workspace destination changed before Home relocation")
        ids.set(reference.id, occupied.id)
        continue
      }
      const previous = existing.get(reference.id)
      const retained = reusable.get(identity(historical))
      if (!binding && retained) {
        ids.set(reference.id, retained.id)
        continue
      }
      const id = previous || !reference.id.startsWith("wsp_") ? `wsp_${randomUUID().replaceAll("-", "")}` : reference.id
      ids.set(reference.id, id)
      const info = WorkspaceCatalog.forImport(
        binding && relocation ? WorktreeRelocation.workspace(historical, relocation.path) : historical,
        id,
      )
      originals.set(id, historical)
      imported.push(binding ? { ...info, binding, revision: info.revision + 1, updatedAt: Date.now() } : info)
    }
    await relocation?.complete()
    const destinations = new Map([...existing.values(), ...imported].map((info) => [info.id, info]))
    for (const info of imported) {
      if (info.binding.state !== "bound") continue
      const original = originals.get(info.id)
      info.sharedWritableWorkspaceIDs = [
        ...new Set(
          (original?.sharedWritableWorkspaceIDs ?? []).flatMap((id) => {
            const targetID = ids.get(id)
            const destination = targetID && destinations.get(targetID)
            return destination &&
              destination.id !== info.id &&
              destination.lifecycle === "active" &&
              destination.scopeID === info.scopeID &&
              destination.binding.state === "bound" &&
              destination.binding.hostID === info.binding.hostID
              ? [destination.id]
              : []
          }),
        ),
      ]
    }
    const resolve: WorkspaceTransfer.Resolve = (reference) => {
      const id = ids.get(reference.id)
      if (!id || references.get(reference.id)?.scopeID !== reference.scopeID)
        throw new Error("Workspace reference changed during Home transfer")
      return id
    }
    return {
      record: (key: string[], value: unknown) => record(key, value, resolve, relocation?.path),
      async publish(tx: StoreTransaction) {
        for (const workspace of imported) {
          if (workspace.binding.state === "bound") await WorkspaceCatalog.writeRelocated(workspace, tx)
          else await WorkspaceCatalog.writeImported(workspace, tx)
        }
      },
    }
  }

  function inside(root: string, filename: string) {
    const relative = path.relative(root, filename)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  async function prepareRelocation(input: { sourceRoot: string; targetRoot: string }) {
    const source = createLocalHost({ root: input.sourceRoot }).workspaceLocation!
    const target = createLocalHost({ root: input.targetRoot }).workspaceLocation!
    const [sourceRoot, targetRoot, sourceHost, targetHost] = await Promise.all([
      fs.realpath(input.sourceRoot),
      fs.realpath(input.targetRoot),
      source.hostID(),
      target.hostID(),
    ])
    if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot))
      throw new Error("Source and target Homes must not overlap")
    const relocate: ScopeTransfer.Relocate = (filename) => {
      if (!path.isAbsolute(filename)) return filename
      for (const root of [sourceRoot, path.resolve(input.sourceRoot)])
        if (inside(root, filename)) return path.join(targetRoot, path.relative(root, filename))
      return filename
    }
    const moved: string[] = []
    return {
      path: relocate,
      complete: () => WorktreeRelocation.repairCopied({ sourceRoot, targetRoot, directories: moved }),
      async binding(info: WorkspaceCatalog.Info): Promise<WorkspaceCatalog.Info["binding"] | undefined> {
        const before = info.binding
        if (
          info.lifecycle !== "active" ||
          before.state !== "bound" ||
          before.hostID !== sourceHost ||
          !before.path ||
          !before.physicalID
        )
          return
        const actual = await source.identify(before.path)
        if (actual.path !== before.path || actual.physicalID !== before.physicalID)
          throw new Error("Workspace directory changed before Home relocation")
        const destination = relocate(actual.path)
        const after = await target.identify(destination)
        if (inside(sourceRoot, actual.path) && !inside(targetRoot, after.path))
          throw new Error("Relocated Workspace escapes the target Home")
        if (destination === actual.path && after.physicalID !== actual.physicalID)
          throw new Error("Workspace directory changed during Home relocation")
        if (destination !== actual.path) moved.push(actual.path)
        return {
          state: "bound",
          hostID: targetHost,
          ...after,
          generation:
            before.generation + (after.path !== actual.path || after.physicalID !== actual.physicalID ? 1 : 0),
        }
      },
    }
  }
}
