import type { PluginComponentProps, PluginSettingsSurfaceContext } from "@ericsanchezok/synergy-plugin"
import { Input } from "@ericsanchezok/synergy-plugin/components"
export default function Preferences({ context }: PluginComponentProps<PluginSettingsSurfaceContext>) {
  const name = () => {
    const value = context.settings.values().name
    return typeof value === "string" ? value : ""
  }
  return (
    <Input
      label="Display name"
      value={name()}
      onChange={(name) => context.settings.change({ ...context.settings.values(), name })}
    />
  )
}
