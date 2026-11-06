export type PluginSettingsResourceKey = {
  pluginId: string
  scopeId: string
}

export function pluginSettingsResourceKey(section: {
  pluginId?: string
  scopeId?: string
}): PluginSettingsResourceKey | undefined {
  if (!section.pluginId || !section.scopeId) return
  return { pluginId: section.pluginId, scopeId: section.scopeId }
}
