import path from "path"
import { existsSync } from "fs"
import { uniqueRoots } from "@/sandbox/policy"
import { Filesystem } from "@/util/filesystem"
import type { Scope } from "./index"
import type { Workspace } from "../session/workspace-schema"

/**
 * Project folder roots — the single source of truth for "which directories
 * belong to this project Scope" consumed by the execution boundary, sandbox
 * policy, system prompt, and file-tool containment checks.
 *
 * `scope.directory` is the directory represented by the current Scope value
 * and drifts depending on how the Scope was loaded (fromDirectory vs fromID),
 * so root derivation must always use the stable `worktree` + persisted
 * `sandboxes` list instead.
 */
export namespace ScopeRoots {
  /**
   * All project folders: the main worktree plus every persisted additional
   * folder. Absolute, deduplicated, existing directories only. The main
   * worktree is always first.
   */
  export function projectRoots(scope: Scope): string[] {
    if (scope.type !== "project") return []
    const worktree = path.resolve(scope.worktree)
    const sandboxes = (scope.sandboxes ?? []).map((dir) => path.resolve(dir)).filter((dir) => dir !== worktree)
    return uniqueRoots([worktree, ...sandboxes]).filter((root) => existsSync(root))
  }

  /**
   * Roots that the execution boundary treats as trusted project folders for
   * the current session. In a git worktree session the original main checkout
   * stays outside the trust boundary (explicit authorization required), while
   * every other declared project folder is trusted automatically.
   */
  export function trustRoots(scope: Scope, workspace?: Workspace): string[] {
    const roots = projectRoots(scope)
    if (workspace?.type !== "git_worktree") return roots
    // The original main checkout is never trusted inside a worktree session,
    // even when the workspace metadata lacks an explicit originalCheckout —
    // the persisted main worktree is the implicit original checkout. The
    // exclusion covers the checkout itself, paths nested under it (e.g.
    // subdirectories auto-recorded into `sandboxes` when they were opened
    // previously), and any declared root that contains the checkout — all of
    // which would otherwise grant write access into the original checkout
    // from an isolated worktree session.
    const originalCheckout =
      (workspace as { originalCheckout?: string } | undefined)?.originalCheckout ?? scope.worktree
    const original = path.resolve(originalCheckout)
    return roots.filter((root) => {
      const resolved = path.resolve(root)
      return !Filesystem.contains(original, resolved) && !Filesystem.contains(resolved, original)
    })
  }
  /**
   * The full trusted-root set used by the execution boundary: project trust
   * roots merged with caller-provided extra roots (e.g. Skill source roots)
   * and deduplicated. Every gate creation site must use this instead of
   * building its own root list so project folders stay trusted automatically.
   */
  export function executionRoots(scope: Scope, workspace: Workspace | undefined, extraRoots: string[] = []): string[] {
    return uniqueRoots([...trustRoots(scope, workspace), ...extraRoots])
  }
}
