import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../project/worktree"
import { ScopeContext } from "../scope/context"
import { PermissionNext } from "../permission/next"
import { EnforcementError } from "@/enforcement/errors"

const parameters = z.object({
  target: z.string().min(1).optional().describe("Target worktree name, ID, branch, or path to enter"),
  baseRef: z
    .enum(["current", "fresh"])
    .optional()
    .default("current")
    .describe("Base reference for new worktree: current HEAD or fresh from origin"),
  reason: z.string().optional().describe("Optional short note about why the worktree is being entered"),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force enter even if the current or target worktree has uncommitted changes"),
})

interface WorktreeEnterMetadata {
  action: "denied" | "entered"
  reason?: string
  message: string
  created?: boolean
  worktree?: Worktree.Info
  workspace?: Record<string, unknown>
}

function buildWorkspaceMetadata(info: Worktree.Info): Record<string, unknown> {
  return {
    type: "git_worktree" as const,
    path: info.path,
    scopeID: info.scopeID,
    worktreeID: info.id,
    name: info.name,
    branch: info.branch,
  }
}

function denialMetadata(
  action: string,
  reason: string,
  message: string,
): {
  title: string
  output: string
  metadata: WorktreeEnterMetadata
} {
  return {
    title: "worktree_enter",
    output: message,
    metadata: { action: action as WorktreeEnterMetadata["action"], reason, message },
  }
}

export const WorktreeEnterTool = Tool.define<typeof parameters, WorktreeEnterMetadata>("worktree_enter", {
  description:
    "Create or enter a git worktree for the current session. " +
    "When already in a worktree, calling with a different 'target' switches to that worktree " +
    "(leaving the current one). Calling with no 'target' switches to a new worktree. " +
    "When 'target' matches an existing worktree (by name, ID, branch, or path), enter that worktree. " +
    "When no match is found, create a new worktree using 'target' as the name. " +
    "Omit 'target' to create a new worktree with an auto-generated unique name.",
  parameters,
  async execute(params, ctx) {
    const currentWorkspace = ScopeContext.current.workspace
    if (currentWorkspace?.type === "git_worktree") {
      const cw = currentWorkspace as Record<string, unknown>
      const currentName = (cw.name ?? cw.worktreeID ?? cw.path ?? "unknown") as string
      const currentPath = cw.path as string
      const currentID = cw.worktreeID as string | undefined
      const currentBranch = cw.branch as string | undefined

      // Noop: target matches current worktree
      if (params.target) {
        const t = params.target
        if (t === currentID || t === currentName || t === currentPath || (currentBranch && t === currentBranch)) {
          return {
            title: "worktree_enter",
            output: `Already in worktree "${currentName}" at ${currentPath}.`,
            metadata: {
              action: "entered",
              reason: "already_in_this_worktree",
              created: false,
              message: `Session is already in worktree "${currentName}".`,
              worktree: undefined,
              workspace: currentWorkspace,
            },
          }
        }
      }

      // Switching: refuse if current worktree is dirty and force not set
      const st = await Worktree.status(ctx.sessionID)
      if (st.dirty !== false && !params.force) {
        return denialMetadata(
          "denied",
          "current_dirty",
          `Current worktree "${currentName}" has uncommitted changes. Use 'force' to switch without saving.`,
        )
      }

      await Worktree.leave(ctx.sessionID)
    }

    try {
      await ctx.ask({
        permission: "worktree_enter",
        patterns: [params.target ?? "*"],
        metadata: {
          target: params.target,
          baseRef: params.baseRef,
          reason: params.reason,
        },
      })
    } catch (error) {
      if (
        error instanceof PermissionNext.RejectedError ||
        error instanceof PermissionNext.CorrectedError ||
        error instanceof PermissionNext.DeniedError ||
        error instanceof EnforcementError.PolicyDenied
      ) {
        return denialMetadata(
          "denied",
          "user_denied",
          error instanceof PermissionNext.CorrectedError ? error.message : "User declined worktree for this task.",
        )
      }
      throw error
    }

    if (params.target) {
      try {
        const worktrees = await Worktree.list()
        const match = worktrees.find(
          (wt) =>
            wt.id === params.target ||
            wt.name === params.target ||
            wt.branch === params.target ||
            wt.path === params.target,
        )
        if (match) {
          const entered = await Worktree.enter({
            sessionID: ctx.sessionID,
            target: params.target,
            force: params.force,
          })
          return {
            title: "worktree_enter",
            output: `Entered existing worktree "${entered.name}" at ${entered.path}.`,
            metadata: {
              action: "entered",
              created: false,
              message: `Entered existing worktree "${entered.name}".`,
              worktree: entered,
              workspace: buildWorkspaceMetadata(entered),
            },
          }
        }
      } catch (error) {
        if (error instanceof Worktree.NotGitError) {
          return denialMetadata(
            "denied",
            "not_git_scope",
            "Current scope is not a Git repository; git worktree is unavailable.",
          )
        }
        throw error
      }
    }

    try {
      const created = await Worktree.create({
        name: params.target,
        sessionID: ctx.sessionID,
        baseRef: params.baseRef,
        bind: true,
      })
      return {
        title: "worktree_enter",
        output: `Created and entered worktree "${created.name}" at ${created.path}.`,
        metadata: {
          action: "entered",
          created: true,
          message: `Created new worktree "${created.name}" from ${params.baseRef} base.`,
          worktree: created,
          workspace: buildWorkspaceMetadata(created),
        },
      }
    } catch (error) {
      if (error instanceof Worktree.NotGitError) {
        return denialMetadata(
          "denied",
          "not_git_scope",
          "Current scope is not a Git repository; git worktree is unavailable.",
        )
      }
      if (
        error instanceof Worktree.NameGenerationFailedError ||
        error instanceof Worktree.CreateFailedError ||
        error instanceof Worktree.SetupConfigError ||
        error instanceof Worktree.StartCommandFailedError
      ) {
        return denialMetadata(
          "denied",
          "setup_failed",
          error instanceof Error ? error.message : "Worktree setup failed.",
        )
      }
      throw error
    }
  },
})
