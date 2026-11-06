import path from "path"
import { existsSync } from "fs"
import { uniqueRoots } from "../sandbox/policy"
import { WorkspaceBinding } from "../workspace/binding"
import type { Scope } from "."
import type { Workspace } from "../session/workspace-schema"

export namespace ScopeRoots {
  /**
   * All project folders: the main worktree plus every persisted additional
   * folder. Absolute, deduplicated, existing directories only. The main
   * worktree is always first.
   */
  export function projectRoots(scope: Scope): string[] {
    if (!scope.local) return []
    const worktree = path.resolve(scope.local.worktree)
    const sandboxes = (scope.local.sandboxes ?? []).map((dir) => path.resolve(dir)).filter((dir) => dir !== worktree)
    return uniqueRoots([worktree, ...sandboxes]).filter((root) => existsSync(root))
  }

  export function trustRoots(scope: Scope, workspace?: Workspace | null): string[] {
    if (!workspace) return []
    if (workspace.scopeID !== scope.id) throw new Error("Workspace belongs to another Scope")
    return [path.resolve(workspace.path)]
  }

  export async function executionRoots(scope: Scope, workspace: Workspace | null | undefined): Promise<string[]> {
    if (!workspace) return []
    if (workspace.scopeID !== scope.id) throw new Error("Workspace belongs to another Scope")
    return WorkspaceBinding.writableRoots(workspace)
  }
}
