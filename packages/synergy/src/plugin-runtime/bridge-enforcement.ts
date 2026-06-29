import type { HostBridgeMethod } from "./protocol.js"

// ---------------------------------------------------------------------------
// Bridge method → enforcement capability mapping
// ---------------------------------------------------------------------------

/**
 * Maps each host bridge method to the enforcement gate capability class
 * that must be approved before the plugin can use that bridge method.
 *
 * Bridge preflight uses manifest capability names. Interactive/profile
 * approval happens in the host service that executes the request.
 */
export const BRIDGE_METHOD_CAPABILITY: Partial<Record<HostBridgeMethod, string>> = {
  "config.get": "config:read",
  "config.set": "config:write",
  "secret.get": "secrets",
  "secret.set": "secrets",
  "secret.delete": "secrets",
  "file.read": "filesystem:read",
  "file.write": "filesystem:write",
  "network.fetch": "network",
  "shell.run": "shell",
  "session.getMetadata": "session_data",
  "session.read": "session_data",
  "workspace.getMetadata": "workspace_data",
  "task.run": "task",
}

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
 * @param capabilities The set of manifest capability names this plugin has
 *                   been approved for (e.g. `["filesystem:read"]`).
 */
export function createBridgeEnforcementHandler(
  pluginId: string,
  capabilities: string[],
): (method: HostBridgeMethod, _params: unknown) => BridgeEnforcementResult {
  return (method, _params) => {
    const requiredCap = BRIDGE_METHOD_CAPABILITY[method]
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
  "tool.invoke": true,
  "permission.request": true,
} satisfies Partial<Record<HostBridgeMethod, true>>
