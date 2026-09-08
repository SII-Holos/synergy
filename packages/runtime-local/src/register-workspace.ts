import { $ } from "bun"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { CortexWorkspace } from "@ericsanchezok/synergy-harness/cortex/workspace"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Worktree } from "./workspace/worktree"

const log = Log.create({ service: "runtime.workspace" })

export function registerWorkspace() {
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
        if (state.worktree.branch) {
          const result = await $`git rev-list --count HEAD --not --remotes`.quiet().nothrow().cwd(state.path)
          const localOnly = parseInt(result.stdout.toString().trim(), 10)
          if (!isNaN(localOnly) && localOnly > 0) {
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
