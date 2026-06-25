import { For } from "solid-js"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GeneralStore } from "../types"

const toastTypes = ["info", "success", "warning", "error"] as const

export function GeneralPanel(props: {
  general: GeneralStore
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
}) {
  function toggleMutedToast(type: string, enabled: boolean) {
    const next = enabled
      ? [...props.general.mutedToasts, type]
      : props.general.mutedToasts.filter((item) => item !== type)
    props.onGeneralChange("mutedToasts", Array.from(new Set(next)))
  }

  return (
    <SettingsPage title="General" description="Common behavior and notification preferences.">
      <SettingsSection title="Profile">
        <SettingsFieldGrid>
          <TextField
            label="Username"
            type="text"
            value={props.general.username}
            placeholder="Display name"
            onChange={(value) => props.onGeneralChange("username", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingRow
          title="Snapshot"
          description="Save file snapshots for explicit file restore"
          trailing={
            <Switch checked={props.general.snapshot} onChange={(value) => props.onGeneralChange("snapshot", value)} />
          }
        />
        <SettingRow
          title="Auto Update"
          description="How product updates are handled"
          trailing={
            <SegmentPill
              value={props.general.autoupdate}
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
                { value: "notify", label: "Notify" },
              ]}
              onChange={(value) => props.onGeneralChange("autoupdate", value)}
              showReset
              defaultValue="notify"
              onReset={() => props.onGeneralChange("autoupdate", "notify")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Toasts" description="Suppress specific notification types or override durations in ms.">
        <div class="ds-checkbox-grid">
          <For each={toastTypes}>
            {(type) => (
              <Checkbox
                checked={props.general.mutedToasts.includes(type)}
                onChange={(checked) => toggleMutedToast(type, checked)}
              >
                Mute {type}
              </Checkbox>
            )}
          </For>
        </div>
        <TextField
          label="Duration Overrides"
          multiline
          value={props.general.toastDurations}
          placeholder={"success=3000\nerror=8000"}
          description="One entry per line. Supported keys: info, success, warning, error."
          onChange={(value) => props.onGeneralChange("toastDurations", value)}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
