import type { LocalScope } from "@/context/layout"

export interface ScopeUpdateInput {
  name?: string
  sandboxes?: string[]
}

export interface ScopeUpdateRequest {
  path_scopeID: string
  name?: string
  sandboxes?: string[]
}

export function scopeUpdateRequest(scope: Pick<LocalScope, "id">, input: ScopeUpdateInput): ScopeUpdateRequest {
  const name = input.name?.trim()
  return {
    path_scopeID: scope.id,
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
