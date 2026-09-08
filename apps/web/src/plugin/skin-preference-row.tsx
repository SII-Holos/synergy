import { createMemo, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { usePluginHost } from "./host"
import { getSkin, listSkins, subscribeSkins } from "./registries/skin-registry"
import { pluginSurfaceId } from "./surface-id"

export function SkinPreferenceRow(props: { popoverLayer?: HTMLElement; onThemeChange(id: string): void }) {
  const host = usePluginHost()
  const { _ } = useLingui()
  const [version, setVersion] = createSignal(0)
  onCleanup(subscribeSkins(() => setVersion((value) => value + 1)))
  const title = () => _({ id: "app.plugin.skin.preference.title", message: "Skin" })
  const options = createMemo(() => {
    version()
    const available = [
      {
        value: "synergy",
        label: _({ id: "app.plugin.skin.preference.default", message: "Default appearance" }),
        disabled: false,
      },
      ...listSkins().map((entry) => ({ value: entry.id, label: entry.label ?? entry.id, disabled: false })),
    ]
    if (!available.some((entry) => entry.value === host.skin.selected()))
      available.push({
        value: host.skin.selected(),
        label: _({
          id: "app.plugin.skin.preference.unavailable",
          message: "{skin} (unavailable)",
          values: { skin: host.skin.selected() },
        }),
        disabled: true,
      })
    return available
  })
  return (
    <SettingRow
      title={title()}
      description={_({
        id: "app.plugin.skin.preference.description",
        message: "Choose fonts, textures and surface styling. Your saved font choices take priority.",
      })}
      trailing={
        <MenuField
          value={host.skin.selected()}
          options={options()}
          ariaLabel={title()}
          popoverLayer={props.popoverLayer}
          onChange={(id) => {
            host.skin.select(id)
            const entry = getSkin(id)
            const theme = entry?.definition.theme
            if (!theme || !entry) return
            const localTheme = host
              .plugins()
              .find((plugin) => plugin.pluginId === entry.pluginId)
              ?.contributions.some((item) => item.kind === "ui.theme" && item.id === theme)
            props.onThemeChange(localTheme ? pluginSurfaceId(entry.pluginId, theme) : theme)
          }}
        />
      }
    />
  )
}
