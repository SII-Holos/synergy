import type { HostBridgeMethod } from "./protocol.js"
import { pluginBridgeMethodCapability } from "@ericsanchezok/synergy-plugin/permissions"

// ---------------------------------------------------------------------------
// Bridge method → enforcement capability mapping
// ---------------------------------------------------------------------------

/**
 * Maps each host bridge method to the enforcement gate capability class
 * that must be approved before the plugin can use that bridge method.
 *
 * Bridge preflight uses the same Synergy capability classes as the
 * EnforcementGate. Interactive/profile approval happens in the host service
 * that executes the request.
 */
export const bridgeMethodCapability = pluginBridgeMethodCapability

// ---------------------------------------------------------------------------
// Enforcement handler factory
// ---------------------------------------------------------------------------

export interface BridgeEnforcementResult {
  allowed: boolean
  reason?: string
}

/**
 * Create a pre-flight enforcement check for host bridge requests.
 *
 * The returned function is synchronous and intended to be called inside
 * `spawnPluginProcess`'s `hostRequest` routing before the real bridge
 * handler is invoked.
 *
 * @param pluginId    The plugin making the bridge request.
 * @param capabilities The set of Synergy capability classes this plugin has
 *                   been approved for (e.g. `["file_read"]`).
 */
export function createBridgeEnforcementHandler(
  pluginId: string,
  capabilities: string[],
): (method: HostBridgeMethod, _params: unknown) => BridgeEnforcementResult {
  return (method, _params) => {
    const requiredCap = bridgeMethodCapability(method)
    if (requiredCap === undefined) {
      if (method in METHOD_WITHOUT_PREFLIGHT) return { allowed: true }
      return { allowed: false, reason: `Unknown bridge method: ${method}` }
    }
    if (!capabilities.includes(requiredCap)) {
      return {
        allowed: false,
        reason: `Capability "${requiredCap}" not approved for plugin "${pluginId}"`,
      }
    }
    return { allowed: true }
  }
}

const METHOD_WITHOUT_PREFLIGHT = {
  "cache.get": true,
  "cache.set": true,
  "cache.delete": true,
  "permission.request": true,
} satisfies Partial<Record<HostBridgeMethod, true>>
