export type SecretEntryLike = {
  id: string
  source: unknown
  policy?: { tools?: string[]; maxResolvesPerSession?: number }
  resolvedCount: number
  createdAt: number
}

export type SecretsAction = "register" | "rotate" | "policy" | "remove"

/** Coarse source label for the panel row; the backend records the fine detail. */
export function secretSourceLabel(entry: SecretEntryLike): "user" | "config" | "reference" | "heuristic" {
  const kind = (entry.source as { kind?: string } | undefined)?.kind
  if (kind === "config" || kind === "reference" || kind === "heuristic") return kind
  return "user"
}

/**
 * Whether removing an entry needs a destructive-action confirmation: every
 * removal is revocation, because historical tokens stop resolving.
 */
export function isDestructiveRemoval(entry: SecretEntryLike): boolean {
  return entry.resolvedCount > 0
}

/**
 * Parse a comma-separated tool allowlist into a policy patch. Empty input
 * means "no restriction", which the API represents by clearing the field.
 */
export function parseToolAllowlist(input: string): string[] | undefined {
  const tools = input
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

export function formatToolAllowlist(policy: SecretEntryLike["policy"]): string {
  return policy?.tools?.length ? policy.tools.join(", ") : ""
}

export function parseResolveCap(input: string): number | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const value = Number.parseInt(trimmed, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function formatResolveCap(policy: SecretEntryLike["policy"]): string {
  return policy?.maxResolvesPerSession !== undefined ? String(policy.maxResolvesPerSession) : ""
}

/** Validate a register/rotate draft before hitting the API. */
export function validateSecretDraft(value: string): string | undefined {
  if (!value.trim()) return "empty"
  return undefined
}
