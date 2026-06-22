/**
 * Runtime mode resolution for plugin isolation.
 *
 * Determines whether a plugin runs in-process, in a Node.js Worker thread,
 * or as a separate OS process — based on its source, trust, manifest
 * preferences, and explicit caller overrides.
 *
 * Policy rules (first-match wins):
 *  1. forceProcess flag      → "process"
 *  2. risk === "high"        → "process" (safety override)
 *  3. manifest mode "process" → "process"
 *  4. manifest mode "worker" + userTrusted → "worker"
 *  5. manifest mode "in-process" with third-party source → "process" (forced)
 *  6. Default by source:
 *     - builtin, official, local → "in-process"
 *     - npm, git, url            → "process"
 *
 * Third-party sources: npm, git, url — these are never allowed in-process.
 * Trusted sources: builtin, official, local.
 */

import type { PluginSource } from "../plugin/trust.js"
import type { RuntimeMode } from "./supervisor.js"

export type { PluginSource, RuntimeMode }

// Sources that may run in-process (builtin, official, local).
const TRUSTED_SOURCES: ReadonlySet<PluginSource> = new Set(["builtin", "official", "local"])

export interface ResolveRuntimeModeInput {
  /** How the plugin was acquired. */
  source: PluginSource
  /** Manifest-declared runtime mode, if any. */
  manifestMode?: "in-process" | "worker" | "process"
  /** Whether running in dev mode (source checkout). */
  devMode?: boolean
  /** Whether the user explicitly trusts this plugin. */
  userTrusted?: boolean
  /** Risk classification from the permission/capability evaluator. */
  risk?: "low" | "medium" | "high"
  /** Explicit caller override to force process isolation. */
  forceProcess?: boolean
}

/**
 * Resolve the runtime isolation mode for a plugin.
 *
 * The default strategy applies:
 *  - High-risk plugins are always process-isolated (safety net).
 *  - Third-party plugins (npm, git, url) may never run in-process.
 *  - Worker mode is only available to user-trusted plugins.
 *  - Builtin, official, and local plugins default to in-process.
 */
export function resolveRuntimeMode(input: ResolveRuntimeModeInput): RuntimeMode {
  const { source, manifestMode, userTrusted = false, risk = "low", forceProcess = false } = input

  // Rule 1: forceProcess flag always wins.
  if (forceProcess) return "process"

  // Rule 2: high-risk plugins are always process-isolated.
  if (risk === "high") return "process"

  // Rule 3: manifest "process" is honored.
  if (manifestMode === "process") return "process"

  // Rule 4: manifest "worker" is honored only with user trust.
  if (manifestMode === "worker") {
    if (userTrusted) return "worker"
    // Without user trust, fall through to default.
  }

  // Rule 5: manifest "in-process" is only allowed for trusted sources.
  if (manifestMode === "in-process") {
    if (TRUSTED_SOURCES.has(source)) return "in-process"
    // Third-party requesting in-process → forced to process.
    return "process"
  }

  // Rule 6: default by source.
  if (TRUSTED_SOURCES.has(source)) return "in-process"
  return "process"
}
