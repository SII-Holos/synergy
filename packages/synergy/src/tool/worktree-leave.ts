import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../project/worktree"
import { Instance } from "../scope/instance"
import { PermissionNext } from "../permission/next"

const parameters = z.object({
  cleanup: z
    .enum(["keep", "remove_if_clean"])
    .optional()
    .default("keep")
    .describe(
      "Whether to remove the worktree after leaving. 'remove_if_clean' only removes when no uncommitted changes exist.",
    ),
  reason: z.string().optional().describe("Optional short note about why the session is leaving the worktree"),
})

interface WorktreeLeaveMetadata {
  action: "left" | "noop" | "denied"
  reason?: string
  previous?: { type: string; path: string; name?: string }
  restored?: { type: string; path: string }
  cleanup?: { performed: boolean; skippedReason?: string }
  message?: string
}

export const WorktreeLeaveTool = Tool.define<typeof parameters, WorktreeLeaveMetadata>("worktree_leave", {
  description:
    "Leave the current git worktree and return to the main checkout. Unbinds the session from the worktree, " +
    "restores the workspace to the main tree, and optionally removes the worktree if it has no uncommitted changes.",
  parameters,
  async execute(params, ctx) {
    const workspace = Instance.workspace

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

    let isClean: boolean | undefined
    if (params.cleanup === "remove_if_clean") {
      const st = await Worktree.status(ctx.sessionID)
      isClean = st.dirty === false
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
    const restored = { type: "main", path: Instance.scope.directory }

    let cleanupResult: { performed: boolean; skippedReason?: string } = { performed: false }
    if (params.cleanup === "remove_if_clean" && worktreeID) {
      if (isClean) {
        await Worktree.remove({ sessionID: ctx.sessionID, target: worktreeID, force: false })
        cleanupResult = { performed: true }
      } else {
        cleanupResult = { performed: false, skippedReason: "dirty" }
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
