import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useTheme, type ColorScheme } from "@ericsanchezok/synergy-ui/theme"
import type { SendShortcut } from "@/context/input"
import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { SegmentPill } from "../components/SegmentPill"

const schemeOptions: { value: ColorScheme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

export function GeneralPanel(props: {
  editingLabel: string
  snapshot: boolean
  autoupdate: string
  sendShortcut: SendShortcut
  onSnapshotChange: (value: boolean) => void
  onAutoupdateChange: (value: string) => void
  onSendShortcutChange: (value: SendShortcut) => void
}) {
  const theme = useTheme()

  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">General</h1>

      <div class="ds-setting-section">
        <SectionLabel title="Appearance" />
        <SettingRow
          title="Color Scheme"
          description="Choose light, dark, or follow your system setting"
          trailing={
            <SegmentPill
              value={theme.colorScheme()}
              options={schemeOptions}
              onChange={(value) => theme.setColorScheme(value as ColorScheme)}
            />
          }
        />
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Server-backed" />
        <p class="ds-section-hint">
          These settings are saved to <strong>{props.editingLabel}</strong> and sync immediately.
        </p>
        <SettingRow
          title="Snapshot"
          description="Save file snapshots for explicit file restore"
          trailing={<Switch checked={props.snapshot} onChange={props.onSnapshotChange} />}
        />
        <SettingRow
          title="Auto Update"
          description="How updates are handled"
          trailing={
            <SegmentPill
              value={props.autoupdate}
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
                { value: "notify", label: "Notify" },
              ]}
              onChange={props.onAutoupdateChange}
              showReset
              defaultValue="notify"
              onReset={() => props.onAutoupdateChange("notify")}
            />
          }
        />
      </div>
      <div class="ds-setting-section">
        <SectionLabel title="Local Preference" />
        <p class="ds-section-hint">Stored only in this client and never written to global config.</p>
        <SettingRow
          title="Send Shortcut"
          description="Choose whether Enter sends immediately or inserts a newline"
          trailing={
            <SegmentPill
              value={props.sendShortcut}
              options={[
                { value: "enter", label: "Enter Sends" },
                { value: "mod-enter", label: "⌘/Ctrl Sends" },
              ]}
              onChange={(value) => props.onSendShortcutChange(value as SendShortcut)}
            />
          }
        />
      </div>
    </div>
  )
}
