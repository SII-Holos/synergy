import { createResource, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import type { StorageSnapshotUsage } from "@ericsanchezok/synergy-sdk/client"
import { formatBytes } from "@/components/library/shared"
import { useGlobalSDK } from "@/context/global-sdk"
import { SettingRow } from "../components/SettingRow"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { GeneralStore } from "../types"

const pageTitle = { id: "settings.storage.page.title", message: "Storage" }
const pageDescription = {
  id: "settings.storage.page.description",
  message: "Inspect file snapshot storage usage per project scope.",
}
const refreshLabel = { id: "settings.storage.refresh", message: "Refresh" }
const usageTitle = { id: "settings.storage.usage.title", message: "Snapshot usage" }
const loadingLabel = { id: "settings.storage.usage.loading", message: "Scanning snapshot storage..." }
const loadFailedLabel = { id: "settings.storage.usage.failed", message: "Snapshot scan failed" }
const emptyLabel = { id: "settings.storage.usage.empty", message: "No snapshot storage found." }
const ownersLabel = { id: "settings.storage.usage.owners", message: "Sessions" }
const legacyLabel = { id: "settings.storage.usage.legacy", message: "Legacy repositories" }
const sharedLabel = { id: "settings.storage.usage.shared", message: "Shared repository" }
const indexesLabel = { id: "settings.storage.usage.indexes", message: "Session work indexes" }
const snapshotsTitle = { id: "settings.storage.snapshots.title", message: "File snapshots" }
const snapshotsDescription = {
  id: "settings.storage.snapshots.description",
  message: "Keep restore points when Synergy edits files",
}
const maintenanceTitle = { id: "settings.storage.maintenance.title", message: "Maintenance" }
const maintenanceDescription = {
  id: "settings.storage.maintenance.description",
  message:
    "Snapshot migration, compaction, and deletion run through the CLI: synergy data snapshots inspect | migrate | compact | clean. Deletion is only performed for permanently deleted sessions.",
}

function ownerSharedSummary(count: number) {
  return {
    id: "settings.storage.usage.owners.shared",
    message: "{count} on shared storage",
    values: { count: String(count) },
  }
}

function ownerLegacySummary(count: number) {
  return {
    id: "settings.storage.usage.owners.legacy",
    message: "{count} on legacy storage",
    values: { count: String(count) },
  }
}

function ownerDeletedSummary(count: number) {
  return {
    id: "settings.storage.usage.owners.deleted",
    message: "{count} pending deletion",
    values: { count: String(count) },
  }
}

function retainedLegacySummary(usage: StorageSnapshotUsage) {
  return {
    id: "settings.storage.usage.retainedLegacy",
    message:
      "{unowned} unowned, {reclaimed} reclaimed, {sharedBaselines} shared baselines, {unregistered} unregistered",
    values: {
      unowned: String(usage.retainedLegacy.unowned),
      reclaimed: String(usage.retainedLegacy.reclaimed),
      sharedBaselines: String(usage.retainedLegacy.sharedBaselines),
      unregistered: String(usage.retainedLegacy.unregistered),
    },
  }
}

export function StoragePanel(props: {
  general: GeneralStore
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
  popoverLayer?: HTMLElement
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()

  const [usage, { refetch }] = createResource(async () => {
    const response = await globalSDK.client.storage.snapshot.usage()
    return response.data
  })

  return (
    <SettingsPage
      title={_(pageTitle)}
      description={_(pageDescription)}
      actions={
        <Button size="small" onClick={() => void refetch()} disabled={usage.loading}>
          {_(refreshLabel)}
        </Button>
      }
    >
      <SettingsSection title={_(usageTitle)}>
        <Show
          when={usage()}
          fallback={<p class="ds-section-hint">{usage.error ? _(loadFailedLabel) : _(loadingLabel)}</p>}
        >
          {(scopes) => (
            <Show when={scopes().length > 0} fallback={<p class="ds-section-hint">{_(emptyLabel)}</p>}>
              <div class="flex flex-col gap-3">
                <For each={scopes()}>
                  {(scope) => (
                    <div class="flex flex-col gap-1">
                      <span class="settings-row-title">{scope.scopeID}</span>
                      <span class="settings-row-description">
                        {_(ownersLabel)}:{" "}
                        <Show when={scope.owners.shared > 0}>{_(ownerSharedSummary(scope.owners.shared))}</Show>
                        <Show when={scope.owners.legacy > 0}>
                          <Show when={scope.owners.shared > 0}>, </Show>
                          {_(ownerLegacySummary(scope.owners.legacy))}
                        </Show>
                        <Show when={scope.owners.deleted > 0}>
                          <Show when={scope.owners.shared > 0 || scope.owners.legacy > 0}>, </Show>
                          {_(ownerDeletedSummary(scope.owners.deleted))}
                        </Show>
                      </span>
                      <span class="settings-row-description">
                        {_(sharedLabel)}: {formatBytes(scope.shared.bytes)} · {_(legacyLabel)}:{" "}
                        {formatBytes(scope.legacy.bytes)} · {_(indexesLabel)}: {formatBytes(scope.indexes.bytes)}
                      </span>
                      <Show when={scope.retainedLegacy.unowned + scope.retainedLegacy.reclaimed > 0}>
                        <span class="settings-row-description">{_(retainedLegacySummary(scope))}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </SettingsSection>

      <SettingsSection>
        <SettingRow
          title={_(snapshotsTitle)}
          description={_(snapshotsDescription)}
          trailing={
            <Switch checked={props.general.snapshot} onChange={(value) => props.onGeneralChange("snapshot", value)} />
          }
        />
      </SettingsSection>

      <SettingsSection title={_(maintenanceTitle)}>
        <p class="ds-section-hint">{_(maintenanceDescription)}</p>
      </SettingsSection>
    </SettingsPage>
  )
}
