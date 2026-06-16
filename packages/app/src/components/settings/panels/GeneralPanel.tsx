import { Switch } from "@ericsanchezok/synergy-ui/switch"
import type { SendShortcut } from "@/context/input"
import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { SegmentPill } from "../components/SegmentPill"

export function GeneralPanel(props: {
  editingLabel: string
  snapshot: boolean
  autoupdate: string
  sendShortcut: SendShortcut
  onSnapshotChange: (value: boolean) => void
  onAutoupdateChange: (value: string) => void
  onSendShortcutChange: (value: SendShortcut) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">General</h1>
      <div class="ds-setting-section">
        <SectionLabel title="Server-backed" />
        <p class="ds-section-hint">
          These settings are saved to the Config Set <strong>{props.editingLabel}</strong> and sync immediately.
        </p>
        <SettingRow
          title="Snapshot"
          description="Save file snapshots for undo/redo"
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
        <p class="ds-section-hint">Stored only in this client and never written to any Config Set.</p>
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
