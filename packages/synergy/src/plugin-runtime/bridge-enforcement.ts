import type { HostBridgeMethod } from "./protocol.js"
import {
  bridgeCapability,
  bridgeMethodPolicy as sharedBridgeMethodPolicy,
  permissionCapability,
} from "@ericsanchezok/synergy-util/capability"

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
export const bridgeMethodCapability = bridgeCapability
export const bridgeMethodPolicy = sharedBridgeMethodPolicy

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
): (method: HostBridgeMethod, params: unknown) => BridgeEnforcementResult {
  return (method, params) => {
    const policy = bridgeMethodPolicy(method)
    if (policy.type === "unknown") {
      return { allowed: false, reason: `Unknown bridge method: ${method}` }
    }
    if (method === "permission.request") {
      const permission = (params as any)?.permission
      if (typeof permission !== "string" || permission.trim() === "") {
        return { allowed: false, reason: "permission.request requires a permission" }
      }
      const requestedCap = permissionCapability(permission)
      if (!capabilities.includes(requestedCap)) {
        return {
          allowed: false,
          reason: `Capability "${requestedCap}" not approved for plugin "${pluginId}"`,
        }
      }
      return { allowed: true }
    }
    if (policy.type === "unprivileged") return { allowed: true }

    const requiredCap = policy.capability
    if (!capabilities.includes(requiredCap)) {
      return {
        allowed: false,
        reason: `Capability "${requiredCap}" not approved for plugin "${pluginId}"`,
      }
    }
    return { allowed: true }
  }
}
