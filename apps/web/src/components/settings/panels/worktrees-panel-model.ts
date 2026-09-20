import type { Worktree } from "@ericsanchezok/synergy-sdk/client"

type WorktreeScope = {
  type?: string
  id: string
  local: { vcs?: "git"; worktree: string } | null
  name?: string
}

export function canDeleteWorktree(info: Pick<Worktree, "managed" | "isMain">) {
  return !!info.managed && !info.isMain
}

export function worktreeLifecycleLabel(lifecycle?: string | null) {
  if (!lifecycle) return null
  if (lifecycle === "active") return "Active"
  if (lifecycle === "gc_candidate") return "GC candidate"
  return lifecycle
}

export function gitProjectScopes(scopes: WorktreeScope[]) {
  return scopes.filter((scope) => scope.type === "project" && scope.local?.vcs === "git")
}

export async function loadWorktreesByScope(
  scopes: Array<Pick<WorktreeScope, "id">>,
  load: (scopeID: string) => Promise<Worktree[]>,
  concurrency = 3,
) {
  const worktrees = new Map<string, Worktree[]>()
  const failures: Array<{ scopeID: string; error: unknown }> = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), scopes.length) }, async () => {
    while (cursor < scopes.length) {
      const scope = scopes[cursor++]!
      try {
        worktrees.set(scope.id, await load(scope.id))
      } catch (error) {
        failures.push({ scopeID: scope.id, error })
      }
    }
  })
  await Promise.all(workers)
  return { worktrees, failures }
}

export function groupWorktreesByScope(
  scopes: Array<{ id: string; name?: string; local: { worktree: string } | null }>,
  worktreesByScope: Map<string, Worktree[]>,
  labelFor: (directory: string, name?: string) => string,
) {
  return scopes.map((scope) => ({
    scopeLabel: labelFor(scope.local?.worktree ?? "", scope.name),
    scopeID: scope.id,
    worktrees: worktreesByScope.get(scope.id) ?? [],
  }))
}
