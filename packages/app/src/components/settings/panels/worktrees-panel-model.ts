import type { Worktree } from "@ericsanchezok/synergy-sdk/client"

export function canDeleteWorktree(info: Pick<Worktree, "managed" | "isMain">) {
  return !!info.managed && !info.isMain
}

export function worktreeLifecycleLabel(lifecycle?: string | null) {
  if (!lifecycle) return null
  if (lifecycle === "active") return "Active"
  if (lifecycle === "gc_candidate") return "GC candidate"
  return lifecycle
}

export function groupWorktreesByDirectory(
  scopes: Array<{ worktree: string; name?: string }>,
  worktreesByDirectory: Map<string, Worktree[]>,
  labelFor: (directory: string, name?: string) => string,
) {
  return scopes.map((scope) => ({
    scopeLabel: labelFor(scope.worktree, scope.name),
    directory: scope.worktree,
    worktrees: worktreesByDirectory.get(scope.worktree) ?? [],
  }))
}
