import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { Worktree } from "@ericsanchezok/synergy-sdk/client"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteWorktreeConfirm } from "@/components/dialog/confirm-copy"
import { formatBytes } from "@/components/library/shared"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { requestErrorMessage } from "@/utils/error"
import { getScopeLabel } from "@/utils/scope"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  canDeleteWorktree,
  gitProjectScopes,
  groupWorktreesByDirectory,
  loadWorktreesByDirectory,
  worktreeLifecycleLabel,
} from "./worktrees-panel-model"

type GroupedWorktrees = { scopeLabel: string; directory: string; worktrees: Worktree[] }

function scopeLabel(directory: string, name?: string) {
  return getScopeLabel({ worktree: directory, name }, directory)
}

const pageTitle = { id: "settings.worktrees.page.title", message: "Worktrees" }
const pageDescription = {
  id: "settings.worktrees.page.description",
  message: "Browse and remove git worktrees across project scopes.",
}
const sectionTitle = { id: "settings.worktrees.section.title", message: "Worktree browser" }
const sectionDescription = {
  id: "settings.worktrees.section.description",
  message: "Synergy-managed worktrees listed by project. Main and external worktrees are read-only.",
}
const refreshLabel = { id: "settings.worktrees.refresh", message: "Refresh" }
const refreshingLabel = { id: "settings.worktrees.refreshing", message: "Refreshing..." }
const emptyTitleUnavailable = { id: "settings.worktrees.empty.unavailable", message: "Worktrees unavailable" }
const emptyTitleNone = { id: "settings.worktrees.empty.none", message: "No worktrees found" }
const emptyDescFailure = {
  id: "settings.worktrees.empty.failure",
  message: "One or more project repositories could not be read. Try refreshing after checking their paths.",
}
const emptyDescNone = {
  id: "settings.worktrees.empty.none.desc",
  message: "Managed worktrees will appear here once created.",
}
const forceRemoveLabel = { id: "settings.worktrees.remove.force", message: "Force remove" }
const forceRemovingLabel = { id: "settings.worktrees.remove.force.removing", message: "Force removing..." }
const deletingLabel = { id: "settings.worktrees.deleting", message: "Deleting..." }
const deleteLabel = { id: "settings.worktrees.delete", message: "Delete" }
const loadErrorAllTitle = { id: "settings.worktrees.loadError.all", message: "Worktrees failed to load" }
const loadErrorSomeTitle = { id: "settings.worktrees.loadError.some", message: "Some worktrees failed to load" }
const loadErrorDesc = {
  id: "settings.worktrees.loadError.desc",
  message: "{count, plural, one {# project scope could not be loaded.} other {# project scopes could not be loaded.}}",
}
const removeSuccessForceTitle = {
  id: "settings.worktrees.remove.force.success",
  message: "Worktree force-removed",
}
const removeSuccessTitle = { id: "settings.worktrees.remove.success", message: "Worktree removed" }
const removeErrorTitle = { id: "settings.worktrees.remove.error", message: "Failed to remove worktree" }
const worktreeCountSummary = {
  id: "settings.worktrees.count",
  message:
    "{worktreeCount, plural, one {# worktree} other {# worktrees}} across {projectCount, plural, one {# project} other {# projects}}",
}
const mainBadgeLabel = { id: "settings.worktrees.badge.main", message: "main" }
const externalBadgeLabel = { id: "settings.worktrees.badge.external", message: "external" }
const managedBadgeLabel = { id: "settings.worktrees.badge.managed", message: "managed" }
const dirtyBadgeLabel = { id: "settings.worktrees.badge.dirty", message: "dirty" }
const staleBadgeLabel = { id: "settings.worktrees.badge.stale", message: "stale" }
const boundSessionSingular = { id: "settings.worktrees.badge.boundSession.singular", message: "bound session" }
const boundSessionPlural = { id: "settings.worktrees.badge.boundSession.plural", message: "bound sessions" }

export function WorktreesPanel() {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const confirm = useConfirm()
  const [loading, setLoading] = createSignal(false)
  const [failureCount, setFailureCount] = createSignal(0)
  const [busyID, setBusyID] = createSignal<string | undefined>()
  const [allWorktrees, setAllWorktrees] = createSignal<Map<string, Worktree[]>>(new Map())
  const [refreshKey, setRefreshKey] = createSignal(0)

  const projectScopes = createMemo(() => {
    const home = globalSync.data.paths?.home
    return gitProjectScopes(globalSync.data.scope, home)
  })

  const grouped = createMemo<GroupedWorktrees[]>(() =>
    groupWorktreesByDirectory(projectScopes(), allWorktrees(), scopeLabel),
  )

  const totalCount = createMemo(() => grouped().reduce((sum, group) => sum + group.worktrees.length, 0))

  async function load(scopes = projectScopes()) {
    if (!globalSDK.connected()) return
    setLoading(true)
    try {
      const result = await loadWorktreesByDirectory(
        scopes,
        async (directory) => {
          const response = await globalSDK.client.worktree.list({ directory })
          return Array.isArray(response.data) ? response.data : []
        },
        3,
      )
      setAllWorktrees(result.worktrees)
      setFailureCount(result.failures.length)
      if (result.failures.length > 0) {
        const first = result.failures[0]!
        showToast({
          type: "error",
          title: result.failures.length === scopes.length ? _(loadErrorAllTitle) : _(loadErrorSomeTitle),
          description: requestErrorMessage(
            first.error,
            _({ ...loadErrorDesc, values: { count: result.failures.length } }),
          ),
        })
      }
    } catch (error) {
      setAllWorktrees(new Map())
      setFailureCount(scopes.length)
      showToast({
        type: "error",
        title: _(loadErrorAllTitle),
        description: requestErrorMessage(error, _({ id: "settings.worktrees.loadError.retry", message: "Try again." })),
      })
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    refreshKey()
    const scopes = projectScopes()
    if (!globalSDK.connected()) return
    void untrack(() => load(scopes))
  })

  async function removeWorktree(item: Worktree, directory: string, force: boolean) {
    setBusyID(item.id)
    try {
      await globalSDK.client.worktree.remove({
        directory,
        worktreeRemoveInput: { target: item.id, force },
      })
      showToast({
        type: "success",
        title: force ? _(removeSuccessForceTitle) : _(removeSuccessTitle),
        description: item.name,
      })
      setRefreshKey((value) => value + 1)
    } catch (error) {
      showToast({
        type: "error",
        title: _(removeErrorTitle),
        description: requestErrorMessage(
          error,
          _({ id: "settings.worktrees.remove.error.retry", message: "Try again." }),
        ),
      })
    } finally {
      setBusyID(undefined)
    }
  }

  function confirmDelete(item: Worktree, directory: string) {
    const dirty = !!item.dirty
    const copy = deleteWorktreeConfirm({
      name: item.name,
      dirty,
      bindings: item.bindings ?? [],
    })
    confirm.show({
      ...copy,
      onConfirm: () => removeWorktree(item, directory, dirty),
    })
  }

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(sectionTitle)} description={_(sectionDescription)}>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="settings-row-description">
              {_({
                ...worktreeCountSummary,
                values: { worktreeCount: totalCount(), projectCount: projectScopes().length },
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon={getSemanticIcon("action.refresh")}
              disabled={loading()}
              onClick={() => void load()}
            >
              {loading() ? _(refreshingLabel) : _(refreshLabel)}
            </Button>
          </div>

          <SettingsEntityList
            isEmpty={!loading() && totalCount() === 0}
            emptyIcon={getSemanticIcon("workspace.worktree")}
            emptyTitle={failureCount() > 0 ? _(emptyTitleUnavailable) : _(emptyTitleNone)}
            emptyDescription={failureCount() > 0 ? _(emptyDescFailure) : _(emptyDescNone)}
          >
            <For each={grouped()}>
              {(group) => (
                <Show when={group.worktrees.length > 0}>
                  <div class="flex flex-col gap-2">
                    <div class="settings-path-meta uppercase tracking-wider px-1">{group.scopeLabel}</div>
                    <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base bg-surface-base/50">
                      <For each={group.worktrees}>
                        {(item) => {
                          const busy = () => busyID() === item.id
                          const canDelete = () => canDeleteWorktree(item)
                          const bindings = item.bindings ?? []
                          return (
                            <div class="flex flex-col gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0 md:flex-row md:items-center md:justify-between">
                              <div class="min-w-0 flex items-start gap-3">
                                <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised-base text-icon-weak-base">
                                  <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
                                </div>
                                <div class="min-w-0">
                                  <div class="settings-row-title truncate">{item.name}</div>
                                  <div class="settings-path-meta flex items-center gap-1.5 mt-0.5">
                                    <Show when={item.branch}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">{item.branch}</span>
                                    </Show>
                                    <Show when={item.isMain}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">{_(mainBadgeLabel)}</span>
                                    </Show>
                                    <Show when={!item.managed && !item.isMain}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">{_(externalBadgeLabel)}</span>
                                    </Show>
                                    <Show when={item.managed}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">{_(managedBadgeLabel)}</span>
                                    </Show>
                                    <Show when={item.dirty}>
                                      <span class="ds-inline-badge ds-inline-badge-muted text-text-diff-delete-base">
                                        {_(dirtyBadgeLabel)}
                                      </span>
                                    </Show>
                                    <Show when={item.stale}>
                                      <span class="ds-inline-badge ds-inline-badge-muted text-text-weaker">
                                        {_(staleBadgeLabel)}
                                      </span>
                                    </Show>
                                  </div>
                                  <div class="settings-path-meta mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span class="truncate" title={item.path}>
                                      {item.path}
                                    </span>
                                    <Show when={item.diskBytes != null}>
                                      <span>{formatBytes(item.diskBytes!)}</span>
                                    </Show>
                                    <Show when={bindings.length > 0}>
                                      <span>
                                        {bindings.length}{" "}
                                        {bindings.length === 1 ? _(boundSessionSingular) : _(boundSessionPlural)}
                                      </span>
                                    </Show>
                                    <Show when={worktreeLifecycleLabel(item.lifecycle)}>
                                      {(label) => <span>{label()}</span>}
                                    </Show>
                                  </div>
                                </div>
                              </div>
                              <Show when={canDelete()}>
                                <div class="flex flex-wrap items-center gap-2 md:justify-end">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="small"
                                    icon={getSemanticIcon("action.remove")}
                                    disabled={busy()}
                                    onClick={() => confirmDelete(item, group.directory)}
                                  >
                                    {busy()
                                      ? item.dirty
                                        ? _(forceRemovingLabel)
                                        : _(deletingLabel)
                                      : item.dirty
                                        ? _(forceRemoveLabel)
                                        : _(deleteLabel)}
                                  </Button>
                                </div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              )}
            </For>
          </SettingsEntityList>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
