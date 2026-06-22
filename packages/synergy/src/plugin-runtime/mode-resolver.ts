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
 *  4. manifest mode "worker" + userTrusted (policy.allowWorkerMode) → "worker"
 *  5. manifest mode "in-process" + third-party + policy.allowThirdPartyInProcess → "in-process"
 *     (otherwise → "process")
 *  6. Default by source (policy.allowLocalInProcess may force local → "process"):
 *     - builtin, official, local → "in-process"
 *     - npm, git, url            → "process"
 *
 * Third-party sources: npm, git, url — only in-process when policy explicitly allows.
 * Trusted sources: builtin, official, local.
 */

import type { PluginSource } from "../plugin/trust.js"
import type { RuntimeMode } from "./supervisor.js"
import { type PluginRuntimePolicy, PLUGIN_RUNTIME_POLICY_DEFAULTS } from "../config/schema"

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
  /** Plugin runtime policy config (defaults from PLUGIN_RUNTIME_POLICY_DEFAULTS when omitted). */
  policy?: PluginRuntimePolicy
}

/**
 * Resolve the runtime isolation mode for a plugin.
 *
 * The default strategy applies:
 *  - High-risk plugins are always process-isolated (safety net).
 *  - Third-party plugins (npm, git, url) may never run in-process
 *    unless policy.allowThirdPartyInProcess is true.
 *  - Worker mode is only available to user-trusted plugins when
 *    policy.allowWorkerMode is true.
 *  - Builtin, official, and local plugins default to in-process,
 *    but config may force local into process via allowLocalInProcess.
 */
export function resolveRuntimeMode(input: ResolveRuntimeModeInput): RuntimeMode {
  const {
    source,
    manifestMode,
    userTrusted = false,
    risk = "low",
    forceProcess = false,
    policy = PLUGIN_RUNTIME_POLICY_DEFAULTS,
  } = input

  // Rule 1: forceProcess flag always wins.
  if (forceProcess) return "process"

  // Rule 2: high-risk plugins are always process-isolated.
  if (risk === "high") return "process"

  // Rule 3: manifest "process" is honored.
  if (manifestMode === "process") return "process"

  // Rule 4: manifest "worker" is honored only when policy allows and user trusts.
  if (manifestMode === "worker") {
    if (policy.allowWorkerMode && userTrusted) return "worker"
    // Without user trust or worker mode denied by policy, fall through to default.
  }

  // Rule 5: manifest "in-process" is allowed only when policy permits.
  if (manifestMode === "in-process") {
    const isTrusted = TRUSTED_SOURCES.has(source)
    if (isTrusted) {
      if (source === "local" && !policy.allowLocalInProcess) return "process"
      return "in-process"
    }
    // Third-party requesting in-process → allowed only if policy permits.
    if (policy.allowThirdPartyInProcess) return "in-process"
    return "process"
  }

  // Rule 6: default by source — policy may override local.
  if (source === "local" && !policy.allowLocalInProcess) return "process"
  if (TRUSTED_SOURCES.has(source)) return "in-process"
  return "process"
}
