import z from "zod"
import { Tool } from "./tool"
import { Worktree } from "../project/worktree"
import { Instance } from "../scope/instance"
import { PermissionNext } from "@/permission/next"
import { EnforcementError } from "@/enforcement/errors"

const parameters = z.object({
  target: z.string().min(1).optional().describe("Target worktree name, ID, branch, or path to enter"),
  baseRef: z
    .enum(["current", "fresh"])
    .optional()
    .default("current")
    .describe("Base reference for new worktree: current HEAD or fresh from origin"),
  reason: z.string().optional().describe("Optional short note about why the worktree is being entered"),
  force: z.boolean().optional().default(false).describe("Force enter even if the worktree has uncommitted changes"),
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
    "Enter a git worktree for the current session. " +
    "The session's workspace is relocated into an isolated worktree directory. " +
    "Provide a target to enter an existing worktree (matched by name, ID, branch, or path) " +
    "or omit target to create a new uniquely-named worktree from the current HEAD.",
  parameters,
  async execute(params, ctx) {
    const currentWorkspace = Instance.workspace
    if (currentWorkspace?.type === "git_worktree") {
      const name = currentWorkspace.name ?? currentWorkspace.worktreeID ?? "unknown"
      return {
        title: "worktree_enter",
        output: `Already in worktree "${name}" at ${currentWorkspace.path}.`,
        metadata: {
          action: "entered",
          created: false,
          message: `Session is already in worktree "${name}".`,
          worktree: undefined,
          workspace: currentWorkspace,
        },
      }
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
