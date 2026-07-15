import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"

export function CodeChecksPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: <K extends keyof RuntimeStore>(key: K, value: RuntimeStore[K]) => void
}) {
  return (
    <SettingsPage title="Code Checks" description="Choose which automated checks appear after Synergy edits code.">
      <SettingsSection title="Language servers">
        <SettingRow
          title="LSP diagnostics after edits"
          description="Include language server errors after write, edit, save_file, and revise_file. Other LSP features stay available."
          trailing={
            <Switch
              checked={props.runtime.lspWriteDiagnostics !== "false"}
              onChange={(checked) => props.onRuntimeChange("lspWriteDiagnostics", checked ? "true" : "false")}
              hideLabel
            >
              LSP diagnostics after edits
            </Switch>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
