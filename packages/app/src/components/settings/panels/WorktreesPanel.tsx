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
          title:
            result.failures.length === scopes.length ? "Worktrees failed to load" : "Some worktrees failed to load",
          description: requestErrorMessage(
            first.error,
            `${result.failures.length} project scopes could not be loaded.`,
          ),
        })
      }
    } catch (error) {
      setAllWorktrees(new Map())
      setFailureCount(scopes.length)
      showToast({
        type: "error",
        title: "Worktrees failed to load",
        description: requestErrorMessage(error, "Try again."),
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
        title: force ? "Worktree force-removed" : "Worktree removed",
        description: item.name,
      })
      setRefreshKey((value) => value + 1)
    } catch (error) {
      showToast({
        type: "error",
        title: "Failed to remove worktree",
        description: requestErrorMessage(error, "Try again."),
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
    <SettingsPage title="Worktrees" description="Browse and remove git worktrees across project scopes.">
      <SettingsSection
        title="Worktree browser"
        description="Synergy-managed worktrees listed by project. Main and external worktrees are read-only."
      >
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <span class="settings-row-description">
              {totalCount()} worktree{totalCount() === 1 ? "" : "s"} across {projectScopes().length} project
              {projectScopes().length === 1 ? "" : "s"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon={getSemanticIcon("action.refresh")}
              disabled={loading()}
              onClick={() => void load()}
            >
              {loading() ? "Refreshing..." : "Refresh"}
            </Button>
          </div>

          <SettingsEntityList
            isEmpty={!loading() && totalCount() === 0}
            emptyIcon={getSemanticIcon("workspace.worktree")}
            emptyTitle={failureCount() > 0 ? "Worktrees unavailable" : "No worktrees found"}
            emptyDescription={
              failureCount() > 0
                ? "One or more project repositories could not be read. Try refreshing after checking their paths."
                : "Managed worktrees will appear here once created."
            }
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
                                      <span class="ds-inline-badge ds-inline-badge-muted">main</span>
                                    </Show>
                                    <Show when={!item.managed && !item.isMain}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">external</span>
                                    </Show>
                                    <Show when={item.managed}>
                                      <span class="ds-inline-badge ds-inline-badge-muted">managed</span>
                                    </Show>
                                    <Show when={item.dirty}>
                                      <span class="ds-inline-badge ds-inline-badge-muted text-text-diff-delete-base">
                                        dirty
                                      </span>
                                    </Show>
                                    <Show when={item.stale}>
                                      <span class="ds-inline-badge ds-inline-badge-muted text-text-weaker">stale</span>
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
                                        {bindings.length} bound session{bindings.length === 1 ? "" : "s"}
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
                                        ? "Force removing..."
                                        : "Deleting..."
                                      : item.dirty
                                        ? "Force remove"
                                        : "Delete"}
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
