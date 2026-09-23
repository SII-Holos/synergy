import { randomUUID } from "node:crypto"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTransfer } from "@ericsanchezok/synergy-harness/session/workspace-transfer"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import type { StoreTransaction, TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"

export namespace WorkspaceHomeTransfer {
  export const roots = new Set(["workspace", "workspace_scope", "workspace_location"])

  function record(key: string[], value: unknown, resolve: WorkspaceTransfer.Resolve) {
    if (key.length === 4 && key[0] === "agenda" && key[1] === "items")
      return AgendaStore.transferWorkspace(value, resolve)
    return WorkspaceTransfer.record(key, value, resolve)
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
  ) {
    const [incoming, existing] = await Promise.all([catalog(source), catalog(target)])
    const references = new Map<string, WorkspaceTransfer.Reference>()
    const collect: WorkspaceTransfer.Resolve = (reference) => {
      const previous = references.get(reference.id)
      if (previous && previous.scopeID !== reference.scopeID)
        throw new Error("Workspace reference crosses imported Scopes")
      references.set(reference.id, { ...previous, ...reference, legacy: reference.legacy ?? previous?.legacy })
      return reference.id
    }
    for (const workspace of incoming.values()) collect({ id: workspace.id, scopeID: workspace.scopeID })
    await source.snapshot(async (tx) => {
      for await (const entry of tx.records()) if (accept(entry.key)) record(entry.key, entry.value, collect)
    })
    const ids = new Map<string, string>()
    const imported: WorkspaceCatalog.Info[] = []
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
      const previous = existing.get(reference.id)
      const retained = reusable.get(identity(historical))
      if (retained) {
        ids.set(reference.id, retained.id)
        continue
      }
      const id = previous || !reference.id.startsWith("wsp_") ? `wsp_${randomUUID().replaceAll("-", "")}` : reference.id
      ids.set(reference.id, id)
      imported.push(WorkspaceCatalog.forImport(historical, id))
    }
    const resolve: WorkspaceTransfer.Resolve = (reference) => {
      const id = ids.get(reference.id)
      if (!id || references.get(reference.id)?.scopeID !== reference.scopeID)
        throw new Error("Workspace reference changed during Home transfer")
      return id
    }
    return {
      record: (key: string[], value: unknown) => record(key, value, resolve),
      async publish(tx: StoreTransaction) {
        for (const workspace of imported) await WorkspaceCatalog.writeImported(workspace, tx)
      },
    }
  }
}
