/**
 * S9d capability mapping: Host Service capability IDs map onto control-profile
 * permission classes. Owned by the L1 control-profile domain so the
 * enforcement gate can classify plugin tool capabilities without importing
 * the plugin product domain.
 */
const CONTROL_PROFILE_CAPABILITY_BY_HOST_CAPABILITY: Record<string, string> = {
  "task.delegate": "task",
  "asset.write": "file_write",
  "settings.read": "config:read",
  "agent.call": "task",
  "workspace.read": "file_read",
  "workspace.write": "file_write",
}

export function controlProfileCapability(capability: string): string {
  return CONTROL_PROFILE_CAPABILITY_BY_HOST_CAPABILITY[capability] ?? capability
}

export function hasControlProfileCapability(capability: string): boolean {
  return Object.hasOwn(CONTROL_PROFILE_CAPABILITY_BY_HOST_CAPABILITY, capability)
}
