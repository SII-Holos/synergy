import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { SessionTransferWorkspace } from "@ericsanchezok/synergy-harness/session/transfer-workspace"
import { NativeWorkspaceTree } from "./workspace/tree"

const directory = async (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new SessionTransferWorkspace.Rejected({ message: "Invalid Session transfer identity" })
  await fs.mkdir(Global.Path.data, { recursive: true })
  return path.join(await fs.realpath(Global.Path.data), "session-transfers", id, "workspace")
}

export function registerSessionTransferWorkspace() {
  SessionTransferWorkspace.register({
    async capture(workspaceID, store, consume) {
      const info = await WorkspaceCatalog.get(workspaceID, ScopeContext.current.scope.id)
      const workspace = await WorkspaceBinding.validate(info.id, info.scopeID, info.binding.generation)
      return WorkspaceAccess.exclusive([workspace.path], async () => {
        await WorkspaceBinding.validate(info.id, info.scopeID, workspace.generation)
        const runtime = await fs.realpath(Global.Path.root)
        const root = await fs.realpath(workspace.path)
        const relative = path
          .relative(path.join(await fs.realpath(Global.Path.data), "session-transfers"), root)
          .split(path.sep)
        const receivedWorkspace =
          relative.length === 2 && /^[a-f0-9-]{36}$/.test(relative[0]!) && relative[1] === "workspace"
        if (
          !receivedWorkspace &&
          (runtime === root || runtime.startsWith(root + path.sep) || root.startsWith(runtime + path.sep))
        )
          throw new SessionTransferWorkspace.Rejected({ message: "Session transfer Workspace overlaps Runtime data" })
        const git = path.join(workspace.path, ".git")
        const stat = await fs.lstat(git).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (stat && !stat.isDirectory())
          throw new SessionTransferWorkspace.Rejected({
            message: "Session transfer does not support linked Git worktrees",
          })
        if (
          stat &&
          (await fs
            .readdir(path.join(git, "worktrees"))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return []
              throw error
            })
            .then((entries) => entries.length))
        )
          throw new SessionTransferWorkspace.Rejected({
            message: "Session transfer requires a Git root without linked worktrees",
          })
        if (stat && /\b(?:worktree|objectformat|alternates)\s*=/.test(await Bun.file(path.join(git, "config")).text()))
          throw new SessionTransferWorkspace.Rejected({
            message: "Session transfer requires self-contained Git metadata",
          })
        if (await Bun.file(path.join(git, "objects", "info", "alternates")).exists())
          throw new SessionTransferWorkspace.Rejected({
            message: "Session transfer requires self-contained Git objects",
          })
        const tree = await NativeWorkspaceTree.capture(workspace.path, store)
        return consume(info, tree)
      })
    },
    async materialize(id, tree, store) {
      const root = await directory(id)
      const expected = WorkspaceTree.hash(WorkspaceTree.encode(tree))
      await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 })
      let exists = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      const saved = await Storage.read<{ version: 1; expected: string }>(["session_transfer_workspace", id]).catch(
        (error) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        },
      )
      if (exists && !saved && exists.isDirectory() && !exists.isSymbolicLink()) {
        await fs.rm(root, { recursive: true })
        exists = undefined
      }
      if (!exists) await NativeWorkspaceTree.materialize(root, tree, store)
      else if (!exists.isDirectory() || exists.isSymbolicLink())
        throw new SessionTransferWorkspace.Rejected({ message: "Session transfer staging location is occupied" })
      const actual = await NativeWorkspaceTree.capture(root, {
        async put() {},
        async get() {
          throw new SessionTransferWorkspace.Rejected({ message: "Validation does not read objects" })
        },
      })
      if (WorkspaceTree.hash(WorkspaceTree.encode(actual)) !== expected)
        throw new SessionTransferWorkspace.Rejected({ message: "Session transfer staging Workspace changed" })
      await Storage.write(["session_transfer_workspace", id], { version: 1, expected })
      return root
    },
    async validate(id) {
      const root = await directory(id)
      const { expected } = await Storage.read<{ expected: string }>(["session_transfer_workspace", id])
      const tree = await NativeWorkspaceTree.capture(root, {
        async put() {},
        async get() {
          throw new SessionTransferWorkspace.Rejected({ message: "Validation does not read objects" })
        },
      })
      if (WorkspaceTree.hash(WorkspaceTree.encode(tree)) !== expected)
        throw new SessionTransferWorkspace.Rejected({ message: "Session transfer staging Workspace changed" })
      return root
    },
  })
}
