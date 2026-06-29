import path from "path"
import fs from "fs"
import { defaultPluginTrustDecision } from "@ericsanchezok/synergy-plugin/policy"
import type { PluginSource } from "@ericsanchezok/synergy-plugin/policy"
import { Global } from "../global"
import { PluginSpec } from "../util/plugin-spec"

export {
  decideTrust,
  defaultPluginTrustDecision,
  isTrustedPluginSource,
  trustReason,
  trustSummary,
} from "@ericsanchezok/synergy-plugin/policy"
export type { PluginSource, PluginTrustDecision, TrustTier } from "@ericsanchezok/synergy-plugin/policy"

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

export function approvedPluginTrustDecision(input: {
  source: PluginSource
  verifiedIntegrity?: boolean
  devMode?: boolean
}) {
  return defaultPluginTrustDecision({
    source: input.source,
    userTrusted: true,
    verifiedIntegrity: input.verifiedIntegrity ?? input.source === "official",
    devMode: input.devMode ?? false,
  })
}
