import type { Worktree } from "@ericsanchezok/synergy-sdk/client"

type WorktreeScope = {
  type?: string
  vcs?: string
  worktree: string
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

export function gitProjectScopes(scopes: WorktreeScope[], home?: string) {
  return scopes.filter((scope) => scope.type === "project" && scope.vcs === "git" && scope.worktree !== home)
}

export async function loadWorktreesByDirectory(
  scopes: Array<Pick<WorktreeScope, "worktree">>,
  load: (directory: string) => Promise<Worktree[]>,
  concurrency = 3,
) {
  const worktrees = new Map<string, Worktree[]>()
  const failures: Array<{ directory: string; error: unknown }> = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), scopes.length) }, async () => {
    while (cursor < scopes.length) {
      const scope = scopes[cursor++]!
      try {
        worktrees.set(scope.worktree, await load(scope.worktree))
      } catch (error) {
        failures.push({ directory: scope.worktree, error })
      }
    }
  })
  await Promise.all(workers)
  return { worktrees, failures }
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
