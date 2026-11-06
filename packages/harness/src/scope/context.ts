import { Context } from "../util/context"
import { Filesystem } from "../util/filesystem"
import { Scope } from "."
import { WorkspaceBinding } from "../workspace/binding"
import { RuntimeContext } from "../lifecycle/context"

const scopeContext = Context.create<Scope>("scope")
const workspaceContext = Context.create<import("../session/types").Workspace | null>("scope.workspace")

// Lazy bridge to WorkspaceAccess: scope/context sits on the import path of
// workspace/access (via workspace/binding), so neither a static import nor a
// module-init registration here can observe the access namespace before cycles
// settle. Resolve the namespace on first guard use, inside the live call, where
// both modules are fully initialized.
const WorkspaceAccessGuard = {
  cached: undefined as undefined | { ambientSessionID(): string | undefined },
  resolve(): { ambientSessionID(): string | undefined } | undefined {
    if (WorkspaceAccessGuard.cached) return WorkspaceAccessGuard.cached
    try {
      const mod = require("../workspace/access") as {
        WorkspaceAccess?: { ambientSessionID(): string | undefined }
      }
      WorkspaceAccessGuard.cached = mod.WorkspaceAccess
    } catch {
      return undefined
    }
    return WorkspaceAccessGuard.cached
  },
}

export namespace ScopeContext {
  export async function provide<R>(input: {
    scope: Scope
    fn: () => R | Promise<R>
    workspace?: import("../session/types").Workspace | null
  }): Promise<Awaited<R>> {
    let workspace = input.workspace === undefined ? ScopeContext.defaultWorkspace(input.scope) : input.workspace
    if (workspace && !workspace.id && RuntimeContext.tryCurrent()?.storage)
      workspace =
        input.workspace === undefined
          ? await WorkspaceBinding.describeDefault(input.scope)
          : await WorkspaceBinding.migrate(workspace, input.scope.id)
    return (await scopeContext.provide(input.scope, () => workspaceContext.provide(workspace, input.fn))) as Awaited<R>
  }

  export function defaultWorkspace(scope: Scope): import("../session/types").Workspace | null {
    return scope.local ? { type: "main", path: scope.local.directory, scopeID: scope.id } : null
  }

  export function tryScope(): Scope | undefined {
    return scopeContext.tryUse()
  }

  export function tryWorkspace(): import("../session/types").Workspace | null | undefined {
    return workspaceContext.tryUse()
  }

  export function refreshWorkspace(workspace: import("../session/types").Workspace | null, sessionID?: string): void {
    if (workspaceContext.tryUse() === undefined) return
    if (sessionID) {
      // Refuse only when an ambient workspace task belongs to a different
      // session: a foreign session must never let a delegated child's bind/leave
      // overwrite its own ambient workspace. Bare callers (no ambient task, e.g.
      // archive/janitor management paths) and the owning session keep the
      // legacy refresh semantics.
      const ambient = WorkspaceAccessGuard.resolve()?.ambientSessionID()
      if (ambient !== undefined && ambient !== sessionID) return
    }
    workspaceContext.update(workspace)
  }

  export function contains(targetPath: string): boolean {
    const scope = scopeContext.use()
    const ws = workspaceContext.tryUse()
    const roots = Scope.Root.trustRoots(scope, ws)
    if (roots.some((root) => Filesystem.contains(root, targetPath))) return true
    if (ws) return Filesystem.contains(ws.path, targetPath)
    return false
  }

  export const current = {
    get scope(): Scope {
      return scopeContext.use()
    },
    get directory(): string {
      const ws = workspaceContext.tryUse()
      if (!ws)
        throw new Scope.WorkspaceRequiredError({
          message: "A local workspace is required for this operation.",
          scopeID: scopeContext.use().id,
        })
      return ws.path
    },
    get workspace(): import("../session/types").Workspace | null {
      return workspaceContext.use()
    },
    get worktree(): string {
      return Scope.requireLocal(scopeContext.use()).worktree
    },
  }
}
