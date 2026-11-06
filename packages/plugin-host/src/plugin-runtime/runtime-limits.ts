import { readConfig } from "../config-schema"
import { resolveRuntimeLimits, type RuntimeLimits } from "./health"

/**
 * Resolve the effective plugin runtime limits from the canonical
 * `pluginRuntimePolicy.limits` config domain, falling back to the shared
 * defaults when config is unavailable or a value is unset.
 */
export async function resolvePluginRuntimeLimits(): Promise<RuntimeLimits> {
  const config = await readConfig().catch(() => undefined)
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits)
}
