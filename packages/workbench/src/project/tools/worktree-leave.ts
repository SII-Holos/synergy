import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Worktree } from "@ericsanchezok/synergy-local-runtime/workspace/worktree"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const parameters = z.object({
  cleanup: z
    .enum(["keep", "remove_if_clean"])
    .optional()
    .default("keep")
    .describe(
      "Whether to destroy the worktree after leaving. 'keep' (default) leaves it in place. 'remove_if_clean' permanently deletes it when it has no uncommitted changes: the registry entry is removed, the branch is deleted when its content is already on the target branch, and worktree_enter cannot restore it. Use worktree_archive instead when the checkout may be needed again.",
    ),
  reason: z.string().optional().describe("Optional short note about why the session is leaving the worktree"),
})

interface WorktreeLeaveMetadata {
  action: "left" | "noop" | "denied"
  reason?: string
  previous?: { type: string; path: string; name?: string }
  restored?: { type: string; path: string }
  cleanup?: { performed: boolean; skippedReason?: string; error?: string; cleanupDeferred?: boolean }
  message?: string
}

export const WorktreeLeaveTool = Tool.define<typeof parameters, WorktreeLeaveMetadata>("worktree_leave", {
  description:
    "Leave the current git worktree and return to the main checkout. Unbinds the session from the worktree and " +
    "restores the workspace to the main tree. The worktree stays on disk by default; the cleanup parameter can " +
    "permanently delete it instead, and that deletion cannot be undone. Use worktree_archive when isolated work is " +
    "finished and the checkout should stay restorable.",
  parameters,
  async execute(params, ctx) {
    const workspace = ScopeContext.current.workspace

    if (!workspace || workspace.type !== "git_worktree") {
      return {
        title: "worktree_leave",
        output: "Already on the main checkout. No worktree to leave.",
        metadata: {
          action: "noop",
          reason: "already_on_main",
          message: "Already on the main checkout. No worktree to leave.",
        },
      }
    }

    const worktreeID: string | undefined = (workspace as any).worktreeID as string | undefined
    const worktreePath = workspace.path
    const worktreeName: string | undefined = (workspace as any).name as string | undefined

    // Tri-state: `undefined` means the dirty probe could not answer, which is
    // not the same as "clean" and must not be reported as "dirty".
    let dirtyState: boolean | undefined
    if (params.cleanup === "remove_if_clean") {
      const st = await Worktree.status(ctx.sessionID)
      dirtyState = st.dirty
    }

    try {
      await ctx.ask({
        permission: "worktree_leave",
        patterns: [worktreePath],
        metadata: {
          previous: { type: workspace.type, path: worktreePath, name: worktreeName },
          cleanup: params.cleanup,
        },
      })
    } catch (error) {
      if (error instanceof PermissionNext.RejectedError || error instanceof PermissionNext.DeniedError) {
        return {
          title: "worktree_leave",
          output: "User declined leaving the worktree.",
          metadata: {
            action: "denied",
            reason: "user_denied",
            message: "User declined leaving the worktree.",
          },
        }
      }
      throw error
    }

    const previous = { type: workspace.type, path: worktreePath, name: worktreeName }

    await Worktree.leave(ctx.sessionID)
    const restored = { type: "main", path: ScopeContext.current.directory }

    let cleanupResult: { performed: boolean; skippedReason?: string; error?: string; cleanupDeferred?: boolean } = {
      performed: false,
    }
    if (params.cleanup === "remove_if_clean" && worktreeID) {
      if (dirtyState === false) {
        try {
          // The turn issuing this call still holds the worktree's git lock and
          // use token, so removal must be told that the caller is its own turn.
          await Worktree.remove(
            { sessionID: ctx.sessionID, target: worktreeID, force: false },
            { insideCallerTurn: true },
          )
          cleanupResult = { performed: true }
        } catch (error) {
          // Leaving already succeeded, so a failed cleanup must not fail the
          // turn: mark the worktree for the janitor and report the reason.
          const message = error instanceof Error ? error.message : String(error)
          await Worktree.markLifecycle(worktreeID, "gc_candidate").catch(() => undefined)
          cleanupResult = { performed: false, error: message, cleanupDeferred: true }
        }
      } else if (dirtyState === true) {
        cleanupResult = { performed: false, skippedReason: "dirty" }
      } else {
        cleanupResult = { performed: false, skippedReason: "unknown_dirty" }
      }
    }

    const lines = [
      `Left worktree "${worktreeName || worktreePath}" and returned to main checkout.`,
      `Previous: ${worktreePath}`,
      `Restored: ${restored.path}`,
    ]
    if (cleanupResult.performed) {
      lines.push("Worktree removed (was clean).")
    } else if (cleanupResult.skippedReason === "dirty") {
      lines.push("Worktree kept (has uncommitted changes).")
    }

    return {
      title: "worktree_leave",
      output: lines.join("\n"),
      metadata: {
        action: "left",
        previous,
        restored,
        cleanup: cleanupResult,
        message: lines.join("\n"),
      },
    }
  },
})
