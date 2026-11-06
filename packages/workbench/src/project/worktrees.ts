import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { ProjectDirectories } from "./directories"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { z } from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"

export namespace ProjectWorktrees {
  const log = Log.create({ service: "project-worktrees" })
  export const Inventory = z
    .object({
      items: Worktree.InventoryEntry.array(),
      version: z.string(),
      generatedAt: z.number(),
      sync: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }),
    })
    .meta({ ref: "ProjectWorktreeInventory" })
  export type Inventory = z.infer<typeof Inventory>
  const inventoryCache = RuntimeContext.state(
    () => new Map<string, { version: string; expires: number; pending: Promise<Inventory> }>(),
  )

  export async function sources(scopeID: string) {
    const directories = await ProjectDirectories.get(scopeID)
    const records = await WorkspaceCatalog.list(scopeID)
    const ids = new Set(
      directories.folders.filter((folder) => folder.available && folder.git).map((folder) => folder.workspaceID),
    )
    for (const tree of records) {
      if (tree.type !== "git_worktree") continue
      const source = records.find(
        (item) => item.id === tree.metadata.sourceWorkspaceID || item.binding.path === tree.metadata.originalCheckout,
      )
      if (source) ids.add(source.id)
    }
    return { ids: [...ids], records, revision: directories.revision }
  }

  export async function list(scopeID: string): Promise<Worktree.Info[]> {
    return collect(scopeID, () => Worktree.list())
  }

  export async function inventory(scopeID: string): Promise<Inventory> {
    const sync = { epoch: Bus.epoch(), seq: Bus.currentSeq() }
    const current = await sources(scopeID)
    const version = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify([
          current.revision,
          current.records.map((record) => [record.id, record.revision, record.binding.generation]),
        ]),
      )
      .digest("hex")
    const cache = inventoryCache()
    const cached = cache.get(scopeID)
    if (cached && cached.version === version && cached.expires > Date.now()) return cached.pending
    const pending = collect(scopeID, () => Worktree.inventory(), current).then((items) => ({
      items: items.map((item) => Worktree.InventoryEntry.parse(item)),
      version,
      generatedAt: Date.now(),
      sync,
    }))
    const entry = { version, expires: Date.now() + 5_000, pending }
    cache.set(scopeID, entry)
    void pending.catch(() => {
      if (cache.get(scopeID) === entry) cache.delete(scopeID)
    })
    return pending
  }

  async function collect(
    scopeID: string,
    read: () => Promise<Worktree.Info[]>,
    source?: Awaited<ReturnType<typeof sources>>,
  ): Promise<Worktree.Info[]> {
    const { ids, records } = source ?? (await sources(scopeID))
    const results = await Promise.allSettled(ids.map((id) => Worktree.withSource(id, read)))
    const trees = new Map<string, Worktree.Info>()
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        log.warn("Worktree source unavailable", { scopeID, workspaceID: ids[index], error: result.reason })
        continue
      }
      for (const tree of result.value) if (!tree.isMain) trees.set(tree.path, tree)
    }
    for (const record of records) {
      if (
        record.type !== "git_worktree" ||
        record.lifecycle === "deleted" ||
        !record.binding.path ||
        trees.has(record.binding.path)
      )
        continue
      trees.set(record.binding.path, {
        id: String(record.metadata.worktreeID ?? record.id),
        scopeID,
        path: record.binding.path,
        name: String(record.metadata.name ?? record.binding.path.split("/").at(-1)),
        branch: typeof record.metadata.branch === "string" ? record.metadata.branch : undefined,
        sourceWorkspaceID:
          typeof record.metadata.sourceWorkspaceID === "string" ? record.metadata.sourceWorkspaceID : undefined,
        sourceDirectory:
          typeof record.metadata.originalCheckout === "string" ? record.metadata.originalCheckout : undefined,
        stale: true,
      })
    }
    return [...trees.values()]
  }
}
