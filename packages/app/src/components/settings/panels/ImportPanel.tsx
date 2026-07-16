import { createMemo, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type {
  Config,
  ConfigDomainImportApplyResult,
  ConfigDomainImportPlan,
  ConfigDomainSummary,
  ConfigImportScope,
  Scope,
} from "@ericsanchezok/synergy-sdk/client"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { overwriteImportConfirm } from "@/components/dialog/confirm-copy"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { getScopeLabel } from "@/utils/scope"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  buildImportApplyParameters,
  buildImportPlanParameters,
  formatImportValue,
  isConfigImportRevisionConflict,
  loadImportUrl,
  parseImportText,
  planMatchesSelection,
  projectImportScopes,
  type ImportDomainID,
} from "./import-panel-model"

const pageTitle = { id: "settings.import.page.title", message: "Import" }
const pageDescription = {
  id: "settings.import.page.description",
  message: "Review and import selected configuration domains.",
}
const targetTitle = { id: "settings.import.target.title", message: "Target" }
const targetDescription = {
  id: "settings.import.target.description",
  message: "Choose whether imported values apply globally or to one project.",
}
const sourceTitle = { id: "settings.import.source.title", message: "Source" }
const sourceDescription = {
  id: "settings.import.source.description",
  message: "Load JSON or JSONC from a file, a URL, or pasted text.",
}
const planTitle = { id: "settings.import.plan.title", message: "Plan" }
const resultTitle = { id: "settings.import.result.title", message: "Result" }
const importFailedTitle = { id: "settings.import.failed", message: "Import failed" }
const configImportedTitle = { id: "settings.import.configImported", message: "Config imported" }
const configImportedWarnTitle = { id: "settings.import.configImportedWarn", message: "Config imported with warnings" }
const planRefreshedTitle = { id: "settings.import.planRefreshed", message: "Import plan refreshed" }
const planRefreshedDesc = {
  id: "settings.import.planRefreshedDesc",
  message: "Configuration changed after review. Check the refreshed plan before applying again.",
}
const runtimeUpdatedText = { id: "settings.import.runtimeUpdated", message: "Runtime updated" }
const runtimeNeedsAttentionText = {
  id: "settings.import.runtimeNeedsAttention",
  message: "Files imported; runtime needs attention",
}

function updatedDomainsDesc(count: number) {
  return {
    id: "settings.import.updatedDomains",
    message: "Updated {count, plural, one {# domain} other {# domains}}.",
    values: { count },
  }
}
function detectedDomains(count: number) {
  return { id: "settings.import.detectedDomains", message: "{count} detected domain(s)", values: { count } }
}

export function ImportPanel(props: {
  domains: ConfigDomainSummary[]
  scopes: Scope[]
  onImported: () => Promise<void>
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [sourceLabel, setSourceLabel] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [pasted, setPasted] = createSignal("")
  const [config, setConfig] = createSignal<Config>()
  const [plan, setPlan] = createSignal<ConfigDomainImportPlan>()
  const [result, setResult] = createSignal<ConfigDomainImportApplyResult>()
  const [selected, setSelected] = createSignal<ImportDomainID[]>([])
  const [scope, setScope] = createSignal<ConfigImportScope>("global")
  const [projectID, setProjectID] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [applying, setApplying] = createSignal(false)

  const projects = createMemo(() => projectImportScopes(props.scopes))
  const project = createMemo(() => projects().find((item) => item.id === projectID()) ?? projects()[0])
  const selectedSet = createMemo(() => new Set(selected()))
  const availableDomains = createMemo(() => new Set((plan()?.domains ?? []).map((domain) => domain.id)))
  const visibleDomains = createMemo(() => (plan()?.domains ?? []).filter((domain) => selectedSet().has(domain.id)))
  const reviewedSelection = createMemo(() => {
    const current = plan()
    return current ? planMatchesSelection(current.domains, selected()) : false
  })
  const selectedConflicts = createMemo(
    () => plan()?.conflicts.filter((change) => selectedSet().has(domainForKey(change.key))) ?? [],
  )

  function domainForKey(key: string): ImportDomainID {
    return plan()?.domains.find((domain) => domain.changes.some((change) => change.key === key))?.id ?? "general"
  }

  function target() {
    return { scope: scope(), project: scope() === "project" ? project() : undefined }
  }

  function clearReview() {
    setPlan(undefined)
    setResult(undefined)
    setSelected([])
  }

  async function createPlan(nextConfig: Record<string, unknown>, label: string, only?: ImportDomainID[]) {
    setLoading(true)
    try {
      const response = await globalSDK.client.config.import.plan(
        buildImportPlanParameters({
          config: nextConfig as Config,
          source: label,
          only,
          ...target(),
        }),
      )
      if (!response.data) throw new Error("The server did not return an import plan")
      setConfig(nextConfig as Config)
      setPlan(response.data)
      setSelected(response.data.domains.map((domain) => domain.id))
      setSourceLabel(label)
      setResult(undefined)
      return response.data
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    try {
      await createPlan(parseImportText(await file.text(), file.name), file.name)
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    }
  }

  async function handleUrl() {
    const value = url().trim()
    if (!value) return
    setLoading(true)
    try {
      const loaded = await loadImportUrl(value)
      await createPlan(loaded, value)
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  async function handlePaste() {
    try {
      await createPlan(parseImportText(pasted(), "pasted"), "pasted")
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    }
  }

  function toggleDomain(id: ImportDomainID, enabled: boolean) {
    setResult(undefined)
    if (enabled) {
      setSelected((previous) => (previous.includes(id) ? previous : [...previous, id]))
      return
    }
    setSelected((previous) => previous.filter((item) => item !== id))
  }

  async function reviewCurrentTarget() {
    const input = config()
    if (!input) return
    await createPlan(input, sourceLabel())
  }

  async function runApplyImport(input: Config, only: ImportDomainID[]) {
    const currentPlan = plan()
    if (!currentPlan) return
    setApplying(true)
    try {
      const response = await globalSDK.client.config.import.apply(
        buildImportApplyParameters({
          config: input,
          source: sourceLabel(),
          only,
          revision: currentPlan.revision,
          ...target(),
        }),
      )
      if (!response.data) throw new Error("The server did not return an import result")
      setPlan(response.data.plan)
      setResult(response.data)
      showToast({
        type: response.data.reload.success ? "success" : "warning",
        title: response.data.reload.success ? _(configImportedTitle) : _(configImportedWarnTitle),
        description: _(updatedDomainsDesc(response.data.plan.domains.length)),
      })
      await props.onImported()
    } catch (error) {
      if (isConfigImportRevisionConflict(error)) {
        const refreshed = await createPlan(input, sourceLabel(), only)
        if (!refreshed) return
        showToast({
          type: "warning",
          title: _(planRefreshedTitle),
          description: _(planRefreshedDesc),
        })
        return
      }
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setApplying(false)
    }
  }

  async function applyImport() {
    const input = config()
    const only = selected()
    if (!input || only.length === 0) return

    if (!reviewedSelection()) {
      await createPlan(input, sourceLabel(), only)
      return
    }

    const conflictCount = selectedConflicts().length
    if (conflictCount > 0) {
      confirm.show({
        ...overwriteImportConfirm(conflictCount),
        onConfirm: () => runApplyImport(input, only),
      })
      return
    }

    await runApplyImport(input, only)
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(targetTitle)} description={_(targetDescription)}>
        <div class="ds-import-target-row">
          <label class="ds-import-field">
            <span>Scope</span>
            <select
              class="settings-select"
              value={scope()}
              onChange={(event) => {
                setScope(event.currentTarget.value as ConfigImportScope)
                clearReview()
              }}
            >
              <option value="global">Global</option>
              <option value="project">Project</option>
            </select>
          </label>
          <Show when={scope() === "project"}>
            <label class="ds-import-field">
              <span>Project</span>
              <select
                class="settings-select"
                value={project()?.id ?? ""}
                disabled={projects().length === 0}
                onChange={(event) => {
                  setProjectID(event.currentTarget.value)
                  clearReview()
                }}
              >
                <Show when={projects().length === 0}>
                  <option value="">No project available</option>
                </Show>
                <For each={projects()}>
                  {(item) => <option value={item.id}>{getScopeLabel(item, item.directory)}</option>}
                </For>
              </select>
            </label>
          </Show>
          <Show when={config() && !plan()}>
            <Button
              type="button"
              variant="secondary"
              size="normal"
              disabled={loading() || (scope() === "project" && !project())}
              onClick={() => void reviewCurrentTarget()}
            >
              Review Target
            </Button>
          </Show>
        </div>
      </SettingsSection>

      <SettingsSection title={_(sourceTitle)} description={_(sourceDescription)}>
        <div class="ds-import-source-row">
          <label class="ds-import-file-button">
            <Icon name={getSemanticIcon("settings.import")} size="small" />
            File
            <input
              type="file"
              accept=".json,.jsonc,application/json"
              onChange={(event) => void handleFile(event.currentTarget.files?.[0])}
            />
          </label>
          <input
            class="ds-import-url-input"
            value={url()}
            aria-label="Config URL"
            placeholder="https://..."
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
          <Button
            type="button"
            variant="secondary"
            size="normal"
            disabled={loading() || !url().trim() || (scope() === "project" && !project())}
            onClick={() => void handleUrl()}
          >
            Load URL
          </Button>
        </div>
        <div class="ds-import-paste-row">
          <textarea
            class="ds-import-paste-input"
            value={pasted()}
            aria-label="Paste JSON or JSONC"
            placeholder={'{\n  "model": "provider/model"\n}'}
            rows={7}
            onInput={(event) => setPasted(event.currentTarget.value)}
          />
          <Button
            type="button"
            variant="secondary"
            size="normal"
            disabled={loading() || !pasted().trim() || (scope() === "project" && !project())}
            onClick={() => void handlePaste()}
          >
            Review Paste
          </Button>
        </div>
      </SettingsSection>

      <Show when={plan()}>
        <SettingsSection title={_(planTitle)}>
          <div class="ds-import-plan-header">
            <div>
              <div class="settings-import-source-title">{sourceLabel()}</div>
              <div class="settings-import-source-meta">
                {plan()!.scope === "project" ? "Project" : "Global"} · {_(detectedDomains(plan()!.domains.length))}
                {!reviewedSelection() ? " · Selection changed" : ""}
              </div>
            </div>
            <Button
              type="button"
              variant="primary"
              size="normal"
              disabled={applying() || loading() || selected().length === 0}
              onClick={() => void applyImport()}
            >
              {applying() ? "Importing..." : reviewedSelection() ? "Apply" : "Review Selection"}
            </Button>
          </div>

          <div class="ds-import-domain-grid">
            <For each={props.domains}>
              {(domain) => (
                <label
                  class="ds-import-domain-toggle"
                  classList={{ "ds-import-domain-toggle-disabled": !availableDomains().has(domain.id) }}
                >
                  <input
                    type="checkbox"
                    disabled={!availableDomains().has(domain.id)}
                    checked={selectedSet().has(domain.id)}
                    onChange={(event) => toggleDomain(domain.id, event.currentTarget.checked)}
                  />
                  <span>{domain.label}</span>
                </label>
              )}
            </For>
          </div>

          <div class="ds-import-plan-list">
            <For each={visibleDomains()}>
              {(domain) => (
                <div class="ds-import-domain-card">
                  <div class="ds-import-domain-card-header">
                    <div>
                      <div class="settings-import-domain-title">{domain.filename}</div>
                      <div class="settings-import-domain-meta" title={domain.path}>
                        {domain.path}
                      </div>
                    </div>
                    <span class="ds-inline-badge ds-inline-badge-muted">{domain.mode}</span>
                  </div>
                  <For each={domain.changes}>
                    {(change) => (
                      <div
                        class="ds-import-change-row"
                        classList={{ "ds-import-change-row-conflict": change.conflict }}
                      >
                        <div class="ds-import-change-heading">
                          <span class={`ds-import-change-type ds-import-change-type-${change.type}`}>
                            {change.type}
                          </span>
                          <span>{change.key}</span>
                          <Show when={change.conflict}>
                            <span class="ds-inline-badge">Conflict</span>
                          </Show>
                        </div>
                        <div class="ds-import-value-grid">
                          <div>
                            <span>Current</span>
                            <pre>{formatImportValue(change.before)}</pre>
                          </div>
                          <div>
                            <span>Imported</span>
                            <pre>{formatImportValue(change.after)}</pre>
                          </div>
                        </div>
                        <For each={change.diagnostics}>
                          {(diagnostic) => (
                            <div class="ds-import-diagnostic" data-severity={diagnostic.severity}>
                              {diagnostic.message}
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </SettingsSection>
      </Show>

      <Show when={result()}>
        {(applied) => (
          <SettingsSection title={_(resultTitle)}>
            <div class="ds-import-result" data-success={applied().reload.success}>
              <div class="settings-import-source-title">
                {applied().reload.success ? _(runtimeUpdatedText) : _(runtimeNeedsAttentionText)}
              </div>
              <div class="settings-import-source-meta">
                Changed {applied().reload.changedFields.length} field(s) · Reloaded{" "}
                {applied().reload.executed.join(", ") || "none"}
              </div>
              <Show when={applied().reload.restartRequired.length > 0}>
                <div>Restart required for: {applied().reload.restartRequired.join(", ")}</div>
              </Show>
              <For each={applied().reload.warnings}>
                {(warning) => (
                  <div class="ds-import-diagnostic" data-severity="warning">
                    {warning}
                  </div>
                )}
              </For>
              <For each={applied().reload.failures}>
                {(failure) => (
                  <div class="ds-import-diagnostic" data-severity="error">
                    {failure.target}: {failure.message}
                  </div>
                )}
              </For>
            </div>
          </SettingsSection>
        )}
      </Show>
    </SettingsPage>
  )
}
