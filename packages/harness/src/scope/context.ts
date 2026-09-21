import { Context } from "../util/context"
import { Filesystem } from "../util/filesystem"
import { Scope } from "."

const scopeContext = Context.create<Scope>("scope")
const workspaceContext = Context.create<import("../session/types").Workspace | null>("scope.workspace")

export namespace ScopeContext {
  export async function provide<R>(input: {
    scope: Scope
    fn: () => R | Promise<R>
    workspace?: import("../session/types").Workspace | null
  }): Promise<Awaited<R>> {
    const workspace = input.workspace === undefined ? ScopeContext.defaultWorkspace(input.scope) : input.workspace
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

  export function refreshWorkspace(workspace: import("../session/types").Workspace | null): void {
    if (workspaceContext.tryUse() === undefined) return
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
