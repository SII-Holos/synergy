import { createMemo, For, Show } from "solid-js"
import { useTheme, type ColorScheme } from "@ericsanchezok/synergy-ui/theme"
import { listThemes } from "@/plugin"
import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GeneralStore } from "../types"

const schemeOptions: { value: ColorScheme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

export function AppearancePanel(props: { themeId: string; onThemeChange: (value: GeneralStore["theme"]) => void }) {
  const theme = useTheme()
  const themes = createMemo(() => listThemes())

  return (
    <SettingsPage title="Appearance" description="Local color scheme and active UI theme.">
      <SettingsSection title="Color">
        <SettingRow
          title="Color Scheme"
          description="Choose light, dark, or follow the system setting on this device"
          trailing={
            <SegmentPill
              value={theme.colorScheme()}
              options={schemeOptions}
              onChange={(value) => theme.setColorScheme(value as ColorScheme)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Theme" description="Registered themes can be selected here when available.">
        <Show when={themes().length > 0} fallback={<div class="ds-empty-state">No registered themes found</div>}>
          <div class="ds-theme-grid">
            <For each={themes()}>
              {(item) => (
                <button
                  type="button"
                  class="ds-profile-card"
                  classList={{ "ds-profile-card-active": props.themeId === item.id }}
                  onClick={() => props.onThemeChange(item.id)}
                >
                  <span class="ds-profile-name">{item.label}</span>
                  <span class="ds-profile-description">{item.appearance ?? "Adaptive"}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
