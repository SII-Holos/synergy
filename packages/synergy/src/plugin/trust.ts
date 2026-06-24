import path from "path"
import fs from "fs"
import { Global } from "../global"
import { PluginSpec } from "../util/plugin-spec"

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
      tier = "trusted-import"
      reason = devMode ? "local plugin in dev mode" : "local plugin"
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

function sourceFromSpec(spec: string): PluginSource {
  if (spec.startsWith("file://")) return "local"
  if (/^https?:\/\//.test(spec)) return "url"
  if (PluginSpec.isNonRegistry(spec)) return "git"
  return "npm"
}

function sourceFromLockfile(pluginDir: string): PluginSource | undefined {
  try {
    const lockfilePath = path.join(Global.Path.root, "plugin.lock")
    const parsed = JSON.parse(fs.readFileSync(lockfilePath, "utf-8"))
    const entries = Object.values(parsed?.plugins ?? {}) as Array<{ spec?: string; resolved?: string }>
    const normalizedPluginDir = path.resolve(pluginDir)
    for (const entry of entries) {
      if (!entry.spec || !entry.resolved) continue
      const resolved = path.resolve(entry.resolved)
      const relative = path.relative(path.dirname(resolved), normalizedPluginDir)
      const reverse = path.relative(normalizedPluginDir, resolved)
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
        return sourceFromSpec(entry.spec)
      if (reverse === "" || (!reverse.startsWith("..") && !path.isAbsolute(reverse))) return sourceFromSpec(entry.spec)
    }
  } catch {}
}

/**
 * Derive the plugin source classification from its lockfile entry and directory path.
 * Lockfile specs win because cache paths alone cannot distinguish npm from git/url archives.
 */
export function derivePluginSource(pluginDir: string): PluginSource {
  const fromLockfile = sourceFromLockfile(pluginDir)
  if (fromLockfile) return fromLockfile

  const cacheRoot = Global.Path.cache
  const relative = path.relative(cacheRoot, pluginDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "local"
  }
  if (relative.startsWith("plugin-archives")) return "local"
  return "npm"
}
