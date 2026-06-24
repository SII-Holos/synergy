import { Context } from "../util/context"
import { Filesystem } from "../util/filesystem"
import { Scope } from "."

const scopeContext = Context.create<Scope>("scope")
const workspaceContext = Context.create<import("../session/types").Workspace>("scope.workspace")

export namespace ScopeContext {
  export async function provide<R>(input: {
    scope: Scope
    fn: () => R | Promise<R>
    workspace?: import("../session/types").Workspace
  }): Promise<Awaited<R>> {
    return (await scopeContext.provide(input.scope, async () => {
      if (input.workspace) {
        return (await workspaceContext.provide(input.workspace, input.fn)) as Awaited<R>
      }
      return (await input.fn()) as Awaited<R>
    })) as Awaited<R>
  }

  export function tryScope(): Scope | undefined {
    return scopeContext.tryUse()
  }

  export function tryWorkspace(): import("../session/types").Workspace | undefined {
    return workspaceContext.tryUse()
  }

  export function refreshWorkspace(workspace: import("../session/types").Workspace): void {
    if (workspaceContext.tryUse() === undefined) return
    workspaceContext.update(workspace)
  }

  export function contains(targetPath: string): boolean {
    const ws = workspaceContext.tryUse()
    if (ws) return Filesystem.contains(ws.path, targetPath)
    return Scope.contains(scopeContext.use(), targetPath)
  }

  export const current = {
    get scope(): Scope {
      return scopeContext.use()
    },
    get directory(): string {
      const ws = workspaceContext.tryUse()
      return ws?.path ?? scopeContext.use().directory
    },
    get workspace(): import("../session/types").Workspace | undefined {
      return workspaceContext.tryUse()
    },
    get worktree(): string {
      return scopeContext.use().worktree
    },
  }
}
