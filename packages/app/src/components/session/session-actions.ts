import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"

export function sessionActionVisibility(input: { sessionID?: string; scopeKey: string }) {
  const menu = !!input.sessionID
  return {
    menu,
    scopeSpecific: menu && !isHomeScope(input.scopeKey),
  }
}

export function sessionScopeRequest(scopeKey: string): { scopeID: string } | { directory: string } {
  if (isHomeScope(scopeKey)) return { scopeID: HOME_SCOPE_KEY }
  return { directory: scopeKey }
}
