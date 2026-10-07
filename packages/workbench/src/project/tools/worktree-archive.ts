import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const parameters = z.object({
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Managed worktree name, ID, branch, or path. Defaults to the calling session's current worktree; use worktree_list to find another idle worktree.",
    ),
  reason: z.string().optional().describe("Optional short explanation of why the worktree is finished."),
})

interface WorktreeArchiveMetadata {
  action: "archived" | "noop" | "denied"
  worktree?: { id: string; name: string; path: string; branch?: string }
  restored?: { type: string; path: string }
  cleanup?: Worktree.ArchiveResult["cleanup"]
  message: string
}

export const WorktreeArchiveTool = Tool.define<typeof parameters, WorktreeArchiveMetadata>("worktree_archive", {
  description:
    "Archive a finished Synergy-managed git worktree. Use when isolated work is complete, including from the running owner turn, or to reclaim another idle worktree. Optional target accepts a name, ID, branch or path; omitted target selects the caller's current worktree. The caller returns to its original checkout without stopping or archiving the conversation. Idle sessions are rebound before safe removal. Dirty or ignored files, local-only or unverifiable commits, locks and active users keep the checkout; there is no force option. Reports archived/noop/denied, restored checkout and whether cleanup actually happened with its reason. Keeps the branch; retained checkouts can be re-entered with worktree_enter. Removed checkouts have no automatic snapshot restore. Use worktree_leave to leave without requesting reclamation.",
  parameters,
  async execute(params, ctx) {
    ctx.abort.throwIfAborted()
    const session = await Session.get(ctx.sessionID)
    const target = params.target ?? (session.workspace?.type === "git_worktree" ? session.workspace.path : undefined)
    if (!target) {
      return {
        title: "worktree_archive",
        metadata: {
          action: "noop",
          message: "No current worktree to archive. Use worktree_list and supply a managed target.",
        },
        output: "No current worktree to archive. Use worktree_list and supply a managed target.",
      }
    }
    const tree = await Worktree.resolve(target)
    if (!tree.managed || tree.isMain || tree.stale) {
      throw new Worktree.CreateFailedError({
        message: "Only an available Synergy-managed worktree can be archived. Use worktree_list to select one.",
      })
    }
    try {
      await ctx.ask({
        permission: "worktree_archive",
        patterns: [tree.path],
        metadata: { target: tree.id, branch: tree.branch, reason: params.reason },
      })
    } catch (error) {
      if (!(error instanceof PermissionNext.RejectedError || error instanceof PermissionNext.DeniedError)) throw error
      const message = "Worktree archive denied. No workspace binding or files were changed."
      return { title: "worktree_archive", metadata: { action: "denied", message }, output: message }
    }
    ctx.abort.throwIfAborted()
    const result = await Worktree.archive({ sessionID: ctx.sessionID, target: tree.id, signal: ctx.abort })
    const lines = [`Archived worktree "${tree.name}". Conversation remains available and this turn can continue.`]
    if (result.restored) lines.push(`Restored: ${result.restored.path}`)
    if (result.cleanup.performed)
      lines.push(`Checkout removed; branch "${tree.branch}" retained. No automatic snapshot restore.`)
    else if (result.cleanup.state === "unknown")
      lines.push(
        `Checkout removal could not be confirmed. Workspace admission remains fenced until safe reconciliation.${result.cleanup.error ? ` ${result.cleanup.error}` : ""} Use worktree_list to inspect the target; do not assume it can be re-entered.`,
      )
    else
      lines.push(
        `Checkout kept at ${tree.path}: ${result.cleanup.reason ?? "removal_failed"}.${result.cleanup.error ? ` ${result.cleanup.error}` : ""} Re-enter it with worktree_enter or retry archive after resolving the blocker.`,
      )
    if (result.cleanup.performed && result.cleanup.error)
      lines.push(`Checkout removal succeeded, but metadata cleanup needs retry: ${result.cleanup.error}`)
    const message = lines.join("\n")
    return {
      title: "worktree_archive",
      output: message,
      metadata: {
        action: "archived",
        worktree: { id: tree.id, name: tree.name, path: tree.path, branch: tree.branch },
        restored: result.restored,
        cleanup: result.cleanup,
        message,
      },
    }
  },
})
