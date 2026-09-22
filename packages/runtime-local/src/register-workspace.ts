import { SnapshotRestore } from "@ericsanchezok/synergy-harness/session/snapshot-restore"
import { WorkspaceFileRestore } from "./workspace-file/restore"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCoordinator } from "./workspace/coordinator"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Pty } from "./process/pty"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { CortexWorkspace } from "@ericsanchezok/synergy-harness/cortex/workspace"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Worktree } from "./workspace/worktree"

const log = Log.create({ service: "runtime.workspace" })

const workspaceServices: SessionWorkspaceRuntime.Provider = {
  lockWorktree: (directory) => Worktree.lock(directory),
  unlockWorktree: (directory) => Worktree.unlock(directory),
  withWorktree: (directory, sessionID, fn) => Worktree.withUse(directory, sessionID, fn),
  createWorktree: (input) => Worktree.create(input),
  enterWorktree: (input) => Worktree.enter(input),
  async releaseSession(session) {
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        await Pty.removeForSession(session.id)
        if (session.workspace?.type === "git_worktree") await Worktree.detachSession(session.id, session.workspace)
      },
    })
  },
}

export function registerWorkspace() {
  SnapshotRestore.register(WorkspaceFileRestore)
  WorkspaceAccess.register(new WorkspaceCoordinator())
  SessionWorkspaceRuntime.register(workspaceServices)
  CortexWorkspace.register({
    async create(input) {
      const created = await Worktree.create({
        ...input,
        owner: { type: "session", sessionID: input.sessionID },
        bind: false,
      })
      await Worktree.enter({ sessionID: input.sessionID, target: created.id, force: false })
      return created
    },
    async cleanup(input) {
      try {
        const session = await Session.get(input.sessionID)
        const workspace = session.workspace
        if (workspace?.type !== "git_worktree" || !workspace.worktreeID) return
        const state = await Worktree.status(input.sessionID)
        if (!state.worktree || !state.worktree.managed) return
        const owner = state.worktree.owner
        if (owner?.type !== "session" || owner.sessionID !== input.sessionID) return
        if (state.dirty) {
          await Worktree.markLifecycle(state.worktree.id, "gc_candidate")
          log.info("child worktree dirty, marked for gc", {
            taskID: input.taskID,
            worktreeID: state.worktree.id,
            worktreeName: state.worktree.name,
          })
          return
        }
        // One owner for this probe: the shared helper confirms a remote exists
        // before trusting the count, because `--not --remotes` degenerates to
        // the whole local history when the repository has no remote-tracking ref.
        if (state.worktree.branch) {
          const localOnly = await Worktree.localOnlyCommitCount(workspace.path)
          if (localOnly > 0) {
            log.info("child worktree has local-only commits, kept for review", {
              taskID: input.taskID,
              worktreeID: state.worktree.id,
              worktreeName: state.worktree.name,
              branch: state.worktree.branch,
              localCommits: localOnly,
            })
            return
          }
        }
        await Worktree.remove({ sessionID: input.sessionID, target: state.worktree.id, force: false })
        log.info("child worktree removed", {
          taskID: input.taskID,
          worktreeID: state.worktree.id,
          worktreeName: state.worktree.name,
        })
      } catch (error) {
        log.warn("child worktree cleanup failed", { taskID: input.taskID, error })
      }
    },
  })
}
