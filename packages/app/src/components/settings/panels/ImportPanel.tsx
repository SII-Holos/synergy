import { createMemo, createSignal, For, Show } from "solid-js"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { overwriteImportConfirm } from "@/components/dialog/confirm-copy"
import type { ConfigDomainImportPlan, ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"

export function ImportPanel(props: { domains: ConfigDomainSummary[]; onImported: () => Promise<void> }) {
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [sourceLabel, setSourceLabel] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [config, setConfig] = createSignal<Record<string, unknown> | undefined>()
  const [plan, setPlan] = createSignal<ConfigDomainImportPlan | undefined>()
  const [selected, setSelected] = createSignal<Array<ConfigDomainSummary["id"]>>([])
  const [loading, setLoading] = createSignal(false)
  const [applying, setApplying] = createSignal(false)

  const selectedSet = createMemo(() => new Set(selected()))
  const availableDomains = createMemo(() => new Set((plan()?.domains ?? []).map((domain) => domain.id)))
  const visibleDomains = createMemo(() => (plan()?.domains ?? []).filter((domain) => selectedSet().has(domain.id)))
  const selectedConflicts = createMemo(
    () => plan()?.conflicts.filter((change) => selectedSet().has(domainForKey(change.key))) ?? [],
  )

  function domainForKey(key: string): ConfigDomainSummary["id"] {
    return plan()?.domains.find((domain) => domain.changes.some((change) => change.key === key))?.id ?? "general"
  }

  function parseInput(text: string) {
    const errors: ParseError[] = []
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      const first = errors[0]
      throw new Error(`JSONC parse failed: ${printParseErrorCode(first.error)} at offset ${first.offset}`)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Import payload must be an object")
    }
    return parsed as Record<string, unknown>
  }

  async function createPlan(nextConfig: Record<string, unknown>, label: string) {
    setLoading(true)
    try {
      const res = await globalSDK.client.config.import.plan({
        configDomainImportPlanInput: { config: nextConfig as any },
      })
      const nextPlan = res.data!
      setConfig(nextConfig)
      setPlan(nextPlan)
      setSelected(nextPlan.domains.map((domain) => domain.id))
      setSourceLabel(label)
    } catch (error: any) {
      showToast({ type: "error", title: "Import failed", description: error.message })
    } finally {
      setLoading(false)
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    try {
      await createPlan(parseInput(await file.text()), file.name)
    } catch (error: any) {
      showToast({ type: "error", title: "Import failed", description: error.message })
    }
  }

  async function handleUrl() {
    const value = url().trim()
    if (!value) return
    setLoading(true)
    try {
      const res = await fetch(value)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      await createPlan(parseInput(await res.text()), value)
    } catch (error: any) {
      showToast({ type: "error", title: "Import failed", description: error.message })
    } finally {
      setLoading(false)
    }
  }

  function toggleDomain(id: ConfigDomainSummary["id"], enabled: boolean) {
    if (enabled) {
      setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
      return
    }
    setSelected((prev) => prev.filter((item) => item !== id))
  }

  async function runApplyImport(input: Record<string, unknown>, only: Array<ConfigDomainSummary["id"]>) {
    setApplying(true)
    try {
      await globalSDK.client.config.import.apply({
        config: input as any,
        only,
        yes: true,
      })
      showToast({ type: "success", title: "Config imported", description: `Updated ${only.length} domain(s).` })
      await props.onImported()
    } finally {
      setApplying(false)
    }
  }

  async function applyImport() {
    const input = config()
    const only = selected()
    if (!input || only.length === 0) return

    const conflictCount = selectedConflicts().length
    if (conflictCount > 0) {
      confirm.show({
        ...overwriteImportConfirm(conflictCount),
        onConfirm: () => runApplyImport(input, only),
      })
      return
    }

    try {
      await runApplyImport(input, only)
    } catch (error: any) {
      showToast({ type: "error", title: "Import failed", description: error.message })
    }
  }

  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div>
          <h2 class="ds-content-title">Import</h2>
        </div>
      </div>

      <div class="ds-setting-section">
        <div class="ds-import-source-row">
          <label class="ds-import-file-button">
            <Icon name="upload" size="small" />
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
            placeholder="https://..."
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
          <Button type="button" variant="secondary" size="normal" disabled={loading()} onClick={() => void handleUrl()}>
            Load URL
          </Button>
        </div>
      </div>

      <Show when={plan()}>
        <div class="ds-setting-section">
          <div class="ds-import-plan-header">
            <div>
              <div class="settings-import-source-title">{sourceLabel()}</div>
              <div class="settings-import-source-meta">{plan()!.domains.length} detected domain(s)</div>
            </div>
            <Button
              type="button"
              variant="primary"
              size="normal"
              disabled={applying() || selected().length === 0}
              onClick={() => void applyImport()}
            >
              {applying() ? "Importing..." : "Apply"}
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
                    <div class="settings-import-domain-title">{domain.filename}</div>
                    <div class="settings-import-domain-meta">{domain.mode}</div>
                  </div>
                  <For each={domain.changes}>
                    {(change) => (
                      <div
                        class="ds-import-change-row"
                        classList={{ "ds-import-change-row-conflict": change.conflict }}
                      >
                        <span>{change.conflict ? "!" : "-"}</span>
                        <span>{change.key}</span>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
