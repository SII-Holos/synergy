import { createResource, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { StorageSnapshotUsage } from "@ericsanchezok/synergy-sdk/client"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { formatBytes } from "@/components/library/shared"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
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
const cleanupTitle = { id: "settings.storage.cleanup.title", message: "Cleanup" }
const cleanTitle = { id: "settings.storage.clean.title", message: "Reclaim unowned snapshots" }
const cleanDescription = {
  id: "settings.storage.clean.description",
  message:
    "Legacy snapshot directories with no session record, including reclaimed scopes. A dry run is shown first; before deleting, each scope must also pass an integrity check.",
}
const cleanActionLabel = { id: "settings.storage.clean.action", message: "Reclaim" }
const cleanBusyLabel = { id: "settings.storage.clean.busy", message: "Reclaiming..." }
const cleanNothingLabel = { id: "settings.storage.clean.nothing", message: "Nothing to reclaim" }
const cleanConfirmTitle = { id: "settings.storage.clean.confirm.title", message: "Reclaim unowned snapshots" }
const cleanConfirmLabel = { id: "settings.storage.clean.confirm.label", message: "Reclaim" }
const cleanSuccessTitle = { id: "settings.storage.clean.success.title", message: "Unowned snapshots reclaimed" }
const cleanFailedTitle = { id: "settings.storage.clean.failed.title", message: "Snapshot cleanup failed" }
const snapshotsTitle = { id: "settings.storage.snapshots.title", message: "File snapshots" }
const snapshotsDescription = {
  id: "settings.storage.snapshots.description",
  message: "Keep restore points when Synergy edits files",
}
const maintenanceTitle = { id: "settings.storage.maintenance.title", message: "Maintenance" }
const maintenanceDescription = {
  id: "settings.storage.maintenance.description",
  message:
    "Snapshot maintenance runs through the CLI (synergy data snapshots): inspect | check | migrate | compact | clean. migrate moves owned legacy repositories into the shared store, clean reclaims legacy directories that no session owns, and deletion only releases snapshots of permanently deleted sessions.",
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

function cleanConfirmDescription(count: string, bytes: string) {
  return {
    id: "settings.storage.clean.confirm.description",
    message: "{count} snapshots ({bytes}) have no owner record and will be permanently deleted. This cannot be undone.",
    values: { count, bytes },
  }
}

function cleanSuccessDescription(count: string, bytes: string) {
  return {
    id: "settings.storage.clean.success.description",
    message: "Freed {bytes} from {count}.",
    values: { count, bytes },
  }
}

export function StoragePanel(props: {
  general: GeneralStore
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
  popoverLayer?: HTMLElement
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [cleaning, setCleaning] = createSignal(false)

  const [usage, { refetch }] = createResource(async () => {
    const response = await globalSDK.client.storage.snapshot.usage()
    return response.data
  })

  async function reclaimUnowned() {
    if (cleaning()) return
    setCleaning(true)
    try {
      const dry = await globalSDK.client.storage.snapshot.clean({ storageSnapshotCleanInput: { apply: false } })
      if (dry.error) {
        showToast({ type: "error", title: _(cleanFailedTitle), description: requestErrorMessage(dry.error) })
        return
      }
      const reports = dry.data ?? []
      const count = reports.reduce((sum, entry) => sum + entry.candidates.length, 0)
      const bytes = reports.reduce((sum, entry) => sum + entry.candidates.reduce((s, c) => s + c.bytes, 0), 0)
      if (count === 0) {
        showToast({ type: "info", title: _(cleanNothingLabel) })
        return
      }
      confirm.show({
        title: _(cleanConfirmTitle),
        description: _(cleanConfirmDescription(String(count), formatBytes(bytes))),
        confirmLabel: _(cleanConfirmLabel),
        tone: "danger",
        onConfirm: async () => {
          const applied = await globalSDK.client.storage.snapshot.clean({
            storageSnapshotCleanInput: { apply: true },
          })
          if (applied.error) throw applied.error
          const appliedReports = applied.data ?? []
          const removed = appliedReports.reduce((sum, entry) => sum + entry.removed, 0)
          const freed = appliedReports.reduce((sum, entry) => sum + entry.bytes, 0)
          showToast({
            type: "success",
            title: _(cleanSuccessTitle),
            description: _(cleanSuccessDescription(String(removed), formatBytes(freed))),
          })
          await refetch()
        },
      })
    } catch (error) {
      showToast({ type: "error", title: _(cleanFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setCleaning(false)
    }
  }

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

      <SettingsSection title={_(cleanupTitle)}>
        <SettingRow
          title={_(cleanTitle)}
          description={_(cleanDescription)}
          trailing={
            <Button size="small" onClick={() => void reclaimUnowned()} disabled={cleaning()}>
              {cleaning() ? _(cleanBusyLabel) : _(cleanActionLabel)}
            </Button>
          }
        />
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
