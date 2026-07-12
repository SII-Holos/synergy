import type { PluginSource, TrustTier } from "../trust.js"
import type { PluginApprovalPolicy } from "../../config/schema.js"

// ---------------------------------------------------------------------------
// Approval decision result
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  allowed: boolean
  requiresUserConsent: boolean
  autoApproved: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a plugin against the configured approval policy.
 *
 * Rules (evaluated in order):
 * 1. denyHighRiskThirdParty + risk="high" + source not local/builtin → deny
 * 2. autoApproveBuiltin + source="builtin" → auto-approve
 * 3. requireSignatureForMarketplace + source not local + !signed → deny
 * 4. allowUnsignedLocal + source="local" + !signed → allow (requires consent)
 * 5. Otherwise: requires consent
 */
export function evaluatePolicy(input: {
  source: PluginSource
  verified: boolean
  risk: "low" | "medium" | "high"
  trustTier: TrustTier
  signed?: boolean
  policy: PluginApprovalPolicy
}): ApprovalDecision {
  const { source, risk, signed, policy } = input

  // 1. Block high-risk third-party plugins
  if (policy.denyHighRiskThirdParty && risk === "high" && source !== "local" && source !== "builtin") {
    return {
      allowed: false,
      requiresUserConsent: false,
      autoApproved: false,
      reason: `High-risk third-party plugin (source=${source}, risk=${risk}) denied by denyHighRiskThirdParty policy`,
    }
  }

  // 2. Auto-approve builtin plugins
  if (policy.autoApproveBuiltin && source === "builtin") {
    return {
      allowed: true,
      requiresUserConsent: false,
      autoApproved: true,
      reason: "Builtin plugin auto-approved by autoApproveBuiltin policy",
    }
  }

  // 3. Require signature for non-local plugins from marketplace
  if (policy.requireSignatureForMarketplace && source !== "local" && !signed) {
    return {
      allowed: false,
      requiresUserConsent: false,
      autoApproved: false,
      reason: `Unsigned non-local plugin (source=${source}) denied by requireSignatureForMarketplace policy`,
    }
  }

  // 4. Allow unsigned local plugins (requires user consent)
  if (policy.allowUnsignedLocal && source === "local" && !signed) {
    return {
      allowed: true,
      requiresUserConsent: true,
      autoApproved: false,
      reason: "Unsigned local plugin allowed by allowUnsignedLocal policy (user consent required)",
    }
  }

  // 5. Default: requires user consent
  return {
    allowed: true,
    requiresUserConsent: true,
    autoApproved: false,
    reason: "Plugin requires user consent (no policy rule auto-approved or denied)",
  }
}
