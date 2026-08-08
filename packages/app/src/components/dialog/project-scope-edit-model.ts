import type { LocalScope } from "@/context/layout"

export interface ScopeUpdateInput {
  name?: string
  sandboxes?: string[]
}

export interface ScopeUpdateRequest {
  path_scopeID: string
  directory: string
  name?: string
  sandboxes?: string[]
}

/**
 * Build the scope.update request for a project being edited. The stable
 * scopeID is preferred when present; the worktree path is used as the path
 * fallback. `directory` is always carried so the server can resolve and
 * persist projects that are not yet registered (e.g. a freshly opened
 * directory) and self-heal scopeID drift: the handler prefers an existing
 * scopeID and falls back to ?directory= only when the ID is unknown.
 */
export function scopeUpdateRequest(
  scope: Pick<LocalScope, "id" | "worktree">,
  input: ScopeUpdateInput,
): ScopeUpdateRequest {
  const name = input.name?.trim()
  return {
    path_scopeID: scope.id ?? scope.worktree,
    directory: scope.worktree,
    ...(name ? { name } : {}),
    ...(input.sandboxes !== undefined ? { sandboxes: input.sandboxes } : {}),
  }
}
/**
 * Extract a human-readable message from a scope.update error. The SDK client
 * throws the JSON error body ({ name, data: { message } }) on 4xx when
 * throwOnError is set; validation errors also surface a top-level `error`
 * field.
 */
export function scopeUpdateErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    if (typeof data?.message === "string" && data.message.length > 0) return data.message
    if (typeof record.error === "string" && record.error.length > 0) return record.error
    if (typeof record.message === "string" && record.message.length > 0) return record.message
  }
  if (error instanceof Error && error.message.length > 0) return error.message
  return fallback
}
