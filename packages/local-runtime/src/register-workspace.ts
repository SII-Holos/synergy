import { registerSessionTransferWorkspace } from "./session-transfer-workspace"
import { SnapshotLink } from "@ericsanchezok/synergy-harness/session/snapshot-link"
import { FileLink } from "./file/link"
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
import { WorkspaceFileImport } from "@ericsanchezok/synergy-harness/workspace/file-import"
import { WorkspaceFileService } from "./workspace-file/service"
import { registerWorkspaceIdentityMigrations } from "./workspace/identity-migration"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"

const log = Log.create({ service: "runtime.workspace" })

const workspaceServices: SessionWorkspaceRuntime.Provider = {
  prepare: (session, signal) => Worktree.prepareSession(session, signal),
  async homeWorkspace() {
    const directory = path.join(Global.Path.root, "workspaces", "home")
    await fs.mkdir(directory, { recursive: true })
    return WorkspaceCatalog.projection(await WorkspaceBinding.register("home", directory))
  },
  withWorktree: (directory, sessionID, fn) => Worktree.withUse(directory, sessionID, fn),
  createWorktree: (input) => Worktree.create(input),
  enterWorktree: (input) => Worktree.enter(input),
  async releaseSession(session) {
    await ScopeContext.provide({
      scope: session.scope,
      workspace: null,
      fn: async () => {
        await Pty.removeForSession(session.id)
        if (session.workspace?.type === "git_worktree") await Worktree.detachSession(session.id, session.workspace)
      },
    })
  },
}

export function registerWorkspace(coordinator = new WorkspaceCoordinator()) {
  registerWorkspaceIdentityMigrations()
  registerSessionTransferWorkspace()
  SnapshotLink.register({ type: (filename) => FileLink.type(filename) })
  SnapshotRestore.register(WorkspaceFileRestore)
  WorkspaceFileImport.register(WorkspaceFileService)
  WorkspaceAccess.register(coordinator)
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
        if (workspace?.type !== "git_worktree" || typeof workspace.worktreeID !== "string") return
        const worktree = await Worktree.resolve(workspace.worktreeID)
        if (!worktree.managed) return
        const owner = worktree.owner
        if (owner?.type !== "session" || owner.sessionID !== input.sessionID) return
        const cleanup = await Worktree.release(worktree.id)
        log.info("child worktree cleanup", { taskID: input.taskID, worktreeID: worktree.id, ...cleanup })
      } catch (error) {
        log.warn("child worktree cleanup failed", { taskID: input.taskID, error })
      }
    },
  })
}
