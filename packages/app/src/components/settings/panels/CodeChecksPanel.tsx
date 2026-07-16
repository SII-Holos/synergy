import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"
import { codeChecksControlsDisabled } from "./code-checks-model"

export function CodeChecksPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const diagnosticsEnabled = () => !codeChecksControlsDisabled(props.runtime.lspWriteDiagnostics)

  return (
    <SettingsPage
      title="Code Checks"
      description="Choose which language-server diagnostics file-writing tools return after an edit."
    >
      <SettingsSection title="Post-write Diagnostics">
        <SettingRow
          title="Include Diagnostics"
          description="Return language-server feedback after write, edit, save_file, and revise_file."
          trailing={
            <Switch
              checked={diagnosticsEnabled()}
              onChange={(value) => props.onRuntimeChange("lspWriteDiagnostics", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title="Diagnostic Severity"
          description="Include only errors, or include warnings as well."
          trailing={
            <select
              class="settings-select"
              aria-label="Diagnostic severity"
              value={props.runtime.lspDiagnosticsSeverity}
              disabled={!diagnosticsEnabled()}
              onChange={(event) => props.onRuntimeChange("lspDiagnosticsSeverity", event.currentTarget.value)}
            >
              <option value="error">Errors only</option>
              <option value="warning">Errors and warnings</option>
            </select>
          }
        />
        <SettingRow
          title="Diagnostic Scope"
          description="Compare this edit, inspect this file, or include matching diagnostics across the project."
          trailing={
            <select
              class="settings-select"
              aria-label="Diagnostic scope"
              value={props.runtime.lspDiagnosticsScope}
              disabled={!diagnosticsEnabled()}
              onChange={(event) => props.onRuntimeChange("lspDiagnosticsScope", event.currentTarget.value)}
            >
              <option value="delta">Changes from this edit</option>
              <option value="file">Current file</option>
              <option value="project">Project</option>
            </select>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
