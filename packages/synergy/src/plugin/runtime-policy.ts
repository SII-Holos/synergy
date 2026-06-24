import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginSource, TrustTier } from "./trust"

// ---------------------------------------------------------------------------
// Types (compatible with plugin-validate.ts CheckResult)
// ---------------------------------------------------------------------------

export interface CheckResult {
  type: "pass" | "warn" | "error"
  message: string
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

/**
 * Validate that the plugin's runtime mode, capabilities, and trust tier
 * are compatible with the system's safety and isolation policies.
 *
 * Rules (evaluated in order, all results collected):
 * 1. Third-party plugins (npm, git, url) cannot run in-process → error
 * 2. High-risk plugins cannot run in-process → error
 * 3. Trust tier vs runtime mode mismatch → warning (suppressed if requestedTier matches)
 * 4. Worker mode with unsupported capabilities (shell, filesystem:write, mcp:spawn) → warning
 * 5. Process mode without resource limits specified → warning
 */
export function validateRuntimePolicy(input: {
  manifest: PluginManifest
  source: PluginSource
  trustTier: TrustTier
  risk: "low" | "medium" | "high"
}): CheckResult[] {
  const results: CheckResult[] = []
  const { manifest, source, trustTier, risk } = input

  // Resolve effective runtime mode — defaults to "in-process" (matches supervisor.ts)
  const effectiveMode = manifest.runtime?.mode ?? "in-process"
  const isThirdParty = source !== "local" && source !== "builtin"

  // Rule 1: third-party requests in-process → error
  if (isThirdParty && effectiveMode === "in-process") {
    results.push({
      type: "error",
      message: `Third-party plugin (source=${source}) cannot run in-process. Use worker or process isolation.`,
    })
  }

  // Rule 2: high-risk requests in-process → error
  if (risk === "high" && effectiveMode === "in-process") {
    results.push({
      type: "error",
      message: `High-risk plugin cannot run in-process. Use worker or process isolation.`,
    })
  }

  // Rule 3: sandbox+trusted-import mismatch → warning
  // Fire when trust tier doesn't align with the runtime mode.
  // Suppress when the manifest explicitly acknowledges the assigned trust tier.
  const requestedTier = manifest.trust?.requestedTier
  const trustModeMismatch = requestedTier !== undefined && requestedTier !== trustTier

  if (trustTier === "sandbox" && requestedTier !== "sandbox") {
    results.push({
      type: "warn",
      message: `Plugin has sandbox trust tier but effective runtime mode "${effectiveMode}" may not provide full sandbox isolation. Consider using process mode with explicit resource limits.`,
    })
  }

  if (trustModeMismatch) {
    results.push({
      type: "warn",
      message: `Plugin requested trust tier "${requestedTier}" but was assigned "${trustTier}" (source=${source}). Runtime mode is "${effectiveMode}".`,
    })
  }

  // Rule 4: worker mode unsupported APIs → warning
  if (effectiveMode === "worker") {
    const perms = manifest.permissions
    const tools = perms?.tools
    const hasShell = tools?.shell ?? false
    const hasFileWrite = tools?.filesystem === "write"
    const hasMcpSpawn = tools?.mcp === "spawn"

    // Also check contributed tools for per-tool capabilities
    const contributedTools = manifest.contributes?.tools ?? []
    const toolShell = contributedTools.some((t) => t.capabilities?.shell)
    const toolFileWrite = contributedTools.some((t) => t.capabilities?.filesystem === "write")

    if (hasShell || toolShell || hasFileWrite || toolFileWrite || hasMcpSpawn) {
      const unsupported: string[] = []
      if (hasShell || toolShell) unsupported.push("shell")
      if (hasFileWrite || toolFileWrite) unsupported.push("filesystem:write")
      if (hasMcpSpawn) unsupported.push("mcp:spawn")
      results.push({
        type: "warn",
        message: `Worker mode does not fully support: ${unsupported.join(", ")}. Consider process mode for these capabilities.`,
      })
    }
  }

  // Rule 5: process mode missing resources → warning
  if (effectiveMode === "process" && !manifest.runtime?.resources) {
    results.push({
      type: "warn",
      message: `Process mode used without resource limits. Specify runtime.resources to prevent resource exhaustion (e.g., memoryMb, maxConcurrentRequests).`,
    })
  }

  return results
}
