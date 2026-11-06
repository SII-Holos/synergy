export namespace ScopeTransfer {
  export type Relocate = (directory: string) => string

  export function paths(value: unknown, relocate: Relocate): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const scope = value as Record<string, unknown>
    if (!scope.local || typeof scope.local !== "object" || Array.isArray(scope.local)) return value
    const local = scope.local as Record<string, unknown>
    return {
      ...scope,
      local: {
        ...local,
        ...(typeof local.directory === "string" ? { directory: relocate(local.directory) } : {}),
        ...(typeof local.worktree === "string" ? { worktree: relocate(local.worktree) } : {}),
        ...(Array.isArray(local.sandboxes)
          ? { sandboxes: local.sandboxes.map((entry) => (typeof entry === "string" ? relocate(entry) : entry)) }
          : {}),
      },
    }
  }
}
