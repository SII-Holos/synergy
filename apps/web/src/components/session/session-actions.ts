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

export type SessionScopeRequest = { scopeID: string }

export function sessionScopeRequest(scopeID: string): SessionScopeRequest {
  return { scopeID }
}

export function sessionScopeRequestFor(session: { scope: { id: string } }): SessionScopeRequest {
  return { scopeID: session.scope.id }
}
