import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { MenuField } from "../../menu-field/MenuField"
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
  message: "Return language-server feedback after write, edit, save_file, revise_file, and resolve_conflicts.",
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
  popoverLayer?: HTMLElement
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
            <MenuField
              value={props.runtime.lspDiagnosticsSeverity}
              ariaLabel={_(severityAria)}
              disabled={!diagnosticsEnabled()}
              popoverLayer={props.popoverLayer}
              options={[
                { value: "error", label: _(errorsOnly) },
                { value: "warning", label: _(errorsWarnings) },
              ]}
              onChange={(value) => props.onRuntimeChange("lspDiagnosticsSeverity", value)}
            />
          }
        />
        <SettingRow
          title={_(scopeRowTitle)}
          description={_(scopeRowDesc)}
          trailing={
            <MenuField
              value={props.runtime.lspDiagnosticsScope}
              ariaLabel={_(scopeAria)}
              disabled={!diagnosticsEnabled()}
              popoverLayer={props.popoverLayer}
              options={[
                { value: "delta", label: _(deltaScope) },
                { value: "file", label: _(fileScope) },
                { value: "project", label: _(projectScope) },
              ]}
              onChange={(value) => props.onRuntimeChange("lspDiagnosticsScope", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
