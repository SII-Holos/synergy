export type ScopeEventRoute = "scopeRemoval" | "scopeIndexRefresh" | "sessionUpdate" | "ignore"

export function classifyScopeEvent(type: string | undefined, isArchived: boolean): ScopeEventRoute {
  if (type === "scope.removed") return "scopeRemoval"
  if (type === "scope.updated") {
    return isArchived ? "scopeRemoval" : "scopeIndexRefresh"
  }
  if (type === "session.updated") return "sessionUpdate"
  return "ignore"
}
