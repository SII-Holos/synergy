import type { HostBridgeMethod } from "./protocol.js"

// ---------------------------------------------------------------------------
// Bridge method → enforcement capability mapping
// ---------------------------------------------------------------------------

/**
 * Maps each host bridge method to the enforcement gate capability class
 * that must be approved before the plugin can use that bridge method.
 *
 * These capability class names match the decomposition in
 * {@link ../enforcement/gate.ts} (`plugin_file_read`, `plugin_shell`, etc.).
 */
export const BRIDGE_METHOD_CAPABILITY: Record<HostBridgeMethod, string> = {
  "config.get": "plugin_config_read",
  "config.set": "plugin_config_write",
  "secret.get": "plugin_secret_read",
  "secret.set": "plugin_secret_read",
  "secret.delete": "plugin_secret_read",
  "cache.get": "plugin_invoke",
  "cache.set": "plugin_invoke",
  "cache.delete": "plugin_invoke",
  "file.read": "plugin_file_read",
  "file.write": "plugin_file_write",
  "network.fetch": "plugin_network",
  "shell.run": "plugin_shell",
  "session.getMetadata": "plugin_session_read",
  "session.read": "plugin_session_read",
  "workspace.getMetadata": "plugin_workspace_read",
  "tool.invoke": "plugin_invoke",
  "permission.request": "plugin_invoke",
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
 * @param capabilities The set of enforcement capability classes this plugin
 *                   has been approved for (e.g. `["plugin_invoke",
 *                   "plugin_file_read"]`).
 */
export function createBridgeEnforcementHandler(
  pluginId: string,
  capabilities: string[],
): (method: HostBridgeMethod, _params: unknown) => BridgeEnforcementResult {
  return (method, _params) => {
    const requiredCap = BRIDGE_METHOD_CAPABILITY[method]
    if (!requiredCap) {
      return { allowed: false, reason: `Unknown bridge method: ${method}` }
    }
    const approved =
      capabilities.includes(requiredCap) || capabilities.includes(GATE_TO_MANIFEST_CAP[requiredCap] ?? "")
    if (!approved) {
      return {
        allowed: false,
        reason: `Capability "${requiredCap}" not approved for plugin "${pluginId}"`,
      }
    }
    return { allowed: true }
  }
}

const GATE_TO_MANIFEST_CAP: Record<string, string> = {
  plugin_file_read: "filesystem:read",
  plugin_file_write: "filesystem:write",
  plugin_shell: "shell",
  plugin_network: "network",
  plugin_session_read: "session_data",
  plugin_workspace_read: "workspace_data",
  plugin_config_read: "config:read",
  plugin_config_write: "config:write",
  plugin_secret_read: "secrets",
  plugin_invoke: "plugin_invoke",
}
