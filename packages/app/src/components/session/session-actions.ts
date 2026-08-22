import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"

export function sessionActionVisibility(input: { sessionID?: string; scopeKey: string }) {
  const menu = !!input.sessionID
  const project = menu && !isHomeScope(input.scopeKey)
  return {
    menu,
    rename: menu,
    worktree: project,
    export: menu,
    import: menu,
    archive: menu,
    copySessionID: menu,
  }
}

export function sessionModelControlVisibility(input: { canSelectModel: boolean; variantCount: number }) {
  return {
    model: input.canSelectModel,
    variant: input.canSelectModel && input.variantCount > 0,
  }
}

export type SessionScopeRequest = { scopeID: string } | { directory: string }

export function sessionScopeRequest(scopeKey: string): SessionScopeRequest {
  if (isHomeScope(scopeKey)) return { scopeID: HOME_SCOPE_KEY }
  return { directory: scopeKey }
}

export function sessionScopeRequestFor(session: {
  scope: { id: string; type?: string; directory?: string }
}): SessionScopeRequest {
  if (session.scope.type === "home" || session.scope.id === HOME_SCOPE_KEY) return { scopeID: HOME_SCOPE_KEY }
  const directory = session.scope.directory ?? session.scope.id
  return { directory }
}
