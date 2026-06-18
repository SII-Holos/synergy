import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../project/worktree"
import { Instance } from "../scope/instance"

const parameters = z.object({})

interface WorktreeListMetadata {
  action: "listed"
  active: {
    id?: string
    name?: string
    path: string
    branch?: string
  } | null
  worktrees: Array<Worktree.Info & { cleanupRecommendation: string }>
  message: string
}

const description =
  "List all git worktrees in the current repository. Returns each worktree's path, branch, state, and a cleanup recommendation for non-main managed worktrees. The currently active worktree is marked."

export const WorktreeListTool = Tool.define<typeof parameters, WorktreeListMetadata>("worktree_list", {
  description,
  parameters,
  async execute() {
    const worktrees = await Worktree.list()
    const ws = Instance.workspace

    const activeWt = ws ? (worktrees.find((wt) => wt.path === ws.path) ?? null) : null

    const enriched = worktrees.map((wt) => {
      const recommendation = getCleanupRecommendation(wt, activeWt)
      return { ...wt, cleanupRecommendation: recommendation }
    })

    const activeDisplay = activeWt
      ? `${activeWt.name ?? activeWt.path}${activeWt.branch ? ` (${activeWt.branch})` : ""}`
      : "none"

    const message = `${worktrees.length} worktree${worktrees.length !== 1 ? "s" : ""} found. Active: ${activeDisplay}`

    return {
      title: "worktree_list",
      output: message,
      metadata: {
        action: "listed",
        active: activeWt
          ? { id: activeWt.id, name: activeWt.name, path: activeWt.path, branch: activeWt.branch }
          : null,
        worktrees: enriched,
        message,
      },
    }
  },
})

function getCleanupRecommendation(wt: Worktree.Info, active: Worktree.Info | null): string {
  if (active && wt.path === active.path) return "keep"
  if (wt.isMain) return "keep"
  if (!wt.managed) return "external_do_not_manage"
  if (wt.stale) return "safe_to_remove"
  if (wt.dirty) return "inspect_dirty"
  return "keep"
}
