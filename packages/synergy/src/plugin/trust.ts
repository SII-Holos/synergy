/**
 * Plugin trust tier decision module.
 *
 * Determines whether a plugin gets declarative-only, trusted-import, or sandbox
 * execution privileges based on its source, user trust, integrity verification,
 * and dev mode.
 */

export type TrustTier = "declarative" | "trusted-import" | "sandbox"
export type PluginSource = "local" | "official" | "npm" | "git" | "url" | "builtin"

export interface PluginTrustDecision {
  tier: TrustTier
  source: PluginSource
  userTrusted: boolean
  verifiedIntegrity: boolean
  signed?: boolean
  reason: string
}

/**
 * Decide the trust tier for a plugin based on its source and metadata.
 *
 * Default trust assignments:
 *   builtin          → trusted-import
 *   official         → trusted-import
 *   local            → trusted-import
 *   npm              → sandbox (unless userTrusted + verifiedIntegrity)
 *   git              → sandbox (unless userTrusted)
 *   url              → sandbox (always)
 *
 * Overrides:
 *   - devMode: local plugins are always trusted-import.
 *   - userTrusted + verifiedIntegrity promotes npm plugins to trusted-import.
 *   - userTrusted alone promotes git plugins to trusted-import.
 *   - trusted-import is never auto-downgraded.
 */
export function decideTrust(input: {
  source: PluginSource
  pluginDir: string
  globalCacheDir?: string
  userTrusted: boolean
  verifiedIntegrity: boolean
  devMode: boolean
}): PluginTrustDecision {
  const { source, userTrusted, verifiedIntegrity, devMode } = input

  let tier: TrustTier
  let reason: string

  switch (source) {
    case "builtin":
      tier = "trusted-import"
      reason = "builtin plugin is always trusted"
      break

    case "official":
      tier = "trusted-import"
      reason = "official registry plugin is trusted"
      break

    case "local":
      if (devMode) {
        tier = "trusted-import"
        reason = "local plugin in dev mode"
      } else {
        tier = "trusted-import"
        reason = "local plugin"
      }
      break

    case "npm":
      if (userTrusted && verifiedIntegrity) {
        tier = "trusted-import"
        reason = "user-trusted npm plugin with verified integrity"
      } else {
        tier = "sandbox"
        reason = "npm plugin requires explicit user trust and verified integrity"
      }
      break

    case "git":
      if (userTrusted) {
        tier = "trusted-import"
        reason = "user-trusted git plugin"
      } else {
        tier = "sandbox"
        reason = "git plugin requires explicit user trust"
      }
      break

    case "url":
      tier = "sandbox"
      reason = "URL-sourced plugins always run in sandbox"
      break
  }

  return {
    tier,
    source,
    userTrusted,
    verifiedIntegrity,
    reason,
  }
}

/**
 * Return a human-readable explanation of the trust decision, including
 * the contributing factors.
 */
export function trustReason(decision: PluginTrustDecision): string {
  const factors: string[] = []

  if (decision.userTrusted) factors.push("user-trusted")
  if (decision.verifiedIntegrity) factors.push("integrity verified")
  if (decision.signed) factors.push("signed")

  const factorText = factors.length > 0 ? ` (${factors.join(", ")})` : ""
  return `${decision.reason} → ${decision.tier}${factorText}`
}

/**
 * Return a compact one-line summary of the trust decision.
 */
export function trustSummary(decision: PluginTrustDecision): string {
  const metadata: string[] = []
  if (decision.userTrusted) metadata.push("trusted")
  if (decision.verifiedIntegrity) metadata.push("verified")

  const meta = metadata.length > 0 ? ` [${metadata.join(", ")}]` : ""
  return `${decision.source} → ${decision.tier}${meta}`
}
