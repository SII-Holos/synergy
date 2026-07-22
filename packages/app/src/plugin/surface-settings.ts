import type { PluginSurfaceContext } from "@ericsanchezok/synergy-plugin"

type SettingsValues = Record<string, unknown>
type PluginSettingsClient = {
  plugin: {
    getConfig(input: { pluginId: string; scopeID: string }): Promise<{ data?: unknown }>
    updateConfig(input: {
      pluginId: string
      scopeID: string
      pluginConfigUpdate: SettingsValues
    }): Promise<{ data?: unknown }>
  }
}

type SettingsEventDetail = {
  pluginId?: string
  scopeId?: string
  values?: SettingsValues
}

export function createPluginSurfaceSettings(input: {
  client: PluginSettingsClient
  pluginId: string
  scopeId: string
  canWrite?: boolean
  events: EventTarget
}): PluginSurfaceContext["settings"] {
  const values = (value: unknown, fallback: SettingsValues = {}): SettingsValues =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as SettingsValues) : fallback

  return {
    async get() {
      const response = await input.client.plugin.getConfig({ pluginId: input.pluginId, scopeID: input.scopeId })
      return values(response.data)
    },
    async replace(next) {
      if (!input.canWrite) throw new Error("Plugin is not approved for settings.write")
      const response = await input.client.plugin.updateConfig({
        pluginId: input.pluginId,
        scopeID: input.scopeId,
        pluginConfigUpdate: next,
      })
      const saved = values(response.data, next)
      input.events.dispatchEvent(
        new CustomEvent<SettingsEventDetail>("synergy:plugin-config-changed", {
          detail: { pluginId: input.pluginId, scopeId: input.scopeId, values: saved },
        }),
      )
    },
    subscribe(listener) {
      const onChange = (event: Event) => {
        const detail = (event as CustomEvent<SettingsEventDetail>).detail
        if (detail?.pluginId === input.pluginId && detail.scopeId === input.scopeId && detail.values)
          listener(detail.values)
      }
      input.events.addEventListener("synergy:plugin-config-changed", onChange)
      return () => input.events.removeEventListener("synergy:plugin-config-changed", onChange)
    },
  }
}
