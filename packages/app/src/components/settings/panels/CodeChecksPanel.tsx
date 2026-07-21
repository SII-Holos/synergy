import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"
import { codeChecksControlsDisabled } from "./code-checks-model"

const pageTitle = { id: "settings.codeChecks.page.title", message: "Code Checks" }
const pageDesc = {
  id: "settings.codeChecks.page.desc",
  message: "Choose which language-server diagnostics file-writing tools return after an edit.",
}
const sectionTitle = { id: "settings.codeChecks.section.title", message: "Post-write Diagnostics" }
const includeRowTitle = { id: "settings.codeChecks.include.title", message: "Include Diagnostics" }
const includeRowDesc = {
  id: "settings.codeChecks.include.desc",
  message: "Return language-server feedback after write, edit, save_file, and revise_file.",
}
const severityRowTitle = { id: "settings.codeChecks.severity.title", message: "Diagnostic Severity" }
const severityRowDesc = {
  id: "settings.codeChecks.severity.desc",
  message: "Include only errors, or include warnings as well.",
}
const severityAria = { id: "settings.codeChecks.severity.aria", message: "Diagnostic severity" }
const scopeRowTitle = { id: "settings.codeChecks.scope.title", message: "Diagnostic Scope" }
const scopeRowDesc = {
  id: "settings.codeChecks.scope.desc",
  message: "Compare this edit, inspect this file, or include matching diagnostics across the project.",
}
const scopeAria = { id: "settings.codeChecks.scope.aria", message: "Diagnostic scope" }
const errorsOnly = { id: "settings.codeChecks.severity.errorsOnly", message: "Errors only" }
const errorsWarnings = { id: "settings.codeChecks.severity.errorsWarnings", message: "Errors and warnings" }
const deltaScope = { id: "settings.codeChecks.scope.delta", message: "Changes from this edit" }
const fileScope = { id: "settings.codeChecks.scope.file", message: "Current file" }
const projectScope = { id: "settings.codeChecks.scope.project", message: "Project" }

export function CodeChecksPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  const diagnosticsEnabled = () => !codeChecksControlsDisabled(props.runtime.lspWriteDiagnostics)

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDesc)}>
      <SettingsSection title={_(sectionTitle)}>
        <SettingRow
          title={_(includeRowTitle)}
          description={_(includeRowDesc)}
          trailing={
            <Switch
              checked={diagnosticsEnabled()}
              onChange={(value) => props.onRuntimeChange("lspWriteDiagnostics", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(severityRowTitle)}
          description={_(severityRowDesc)}
          trailing={
            <select
              class="settings-select"
              aria-label={_(severityAria)}
              value={props.runtime.lspDiagnosticsSeverity}
              disabled={!diagnosticsEnabled()}
              onChange={(event) => props.onRuntimeChange("lspDiagnosticsSeverity", event.currentTarget.value)}
            >
              <option value="error">{_(errorsOnly)}</option>
              <option value="warning">{_(errorsWarnings)}</option>
            </select>
          }
        />
        <SettingRow
          title={_(scopeRowTitle)}
          description={_(scopeRowDesc)}
          trailing={
            <select
              class="settings-select"
              aria-label={_(scopeAria)}
              value={props.runtime.lspDiagnosticsScope}
              disabled={!diagnosticsEnabled()}
              onChange={(event) => props.onRuntimeChange("lspDiagnosticsScope", event.currentTarget.value)}
            >
              <option value="delta">{_(deltaScope)}</option>
              <option value="file">{_(fileScope)}</option>
              <option value="project">{_(projectScope)}</option>
            </select>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
