import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { ProjectDirectories } from "./directories"

export namespace ProjectWorktrees {
  const log = Log.create({ service: "project-worktrees" })

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
    return { ids: [...ids], records }
  }

  export async function list(scopeID: string): Promise<Worktree.Info[]> {
    const { ids, records } = await sources(scopeID)
    const results = await Promise.allSettled(ids.map((id) => Worktree.withSource(id, () => Worktree.list())))
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
