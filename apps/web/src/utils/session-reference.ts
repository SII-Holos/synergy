import type { SessionAttachmentPart } from "@/context/prompt"

export interface ScopeBinding {
  id: string
  local: { directory: string; worktree: string; sandboxes: string[] } | null
}

export function resolveLegacyScopeID(directory: string, scopes: readonly ScopeBinding[]) {
  if (directory === "home") return "home"
  const exact = scopes.find((scope) => scope.local?.directory === directory)
  if (exact) return exact.id
  const aliases = scopes.filter(
    (scope) => scope.local?.worktree === directory || scope.local?.sandboxes.includes(directory),
  )
  return aliases.length === 1 ? aliases[0]!.id : undefined
}

export function resolveSessionReference(part: SessionAttachmentPart, scopes: readonly ScopeBinding[]) {
  if (part.scopeID) return part
  const scopeID = part.legacyDirectory ? resolveLegacyScopeID(part.legacyDirectory, scopes) : undefined
  if (!scopeID)
    throw new Error(
      `Cannot locate the saved session reference “${part.title || part.sessionId}”. Reattach that session to continue.`,
    )
  const { legacyDirectory: _, ...current } = part
  return { ...current, scopeID }
}
