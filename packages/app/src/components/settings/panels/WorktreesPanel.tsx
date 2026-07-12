import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js"
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
import { getScopeLabel } from "@/utils/scope"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { canDeleteWorktree, groupWorktreesByDirectory, worktreeLifecycleLabel } from "./worktrees-panel-model"

type GroupedWorktrees = { scopeLabel: string; directory: string; worktrees: Worktree[] }

function scopeLabel(directory: string, name?: string) {
  return getScopeLabel({ worktree: directory, name }, directory)
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export function WorktreesPanel() {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const confirm = useConfirm()
  const [loading, setLoading] = createSignal(false)
  const [busyID, setBusyID] = createSignal<string | undefined>()
  const [allWorktrees, setAllWorktrees] = createSignal<Map<string, Worktree[]>>(new Map())
  const [refreshKey, setRefreshKey] = createSignal(0)

  const projectScopes = createMemo(() => {
    const home = globalSync.data.paths?.home
    return globalSync.data.scope.filter((scope) => scope.worktree !== home)
  })

  const grouped = createMemo<GroupedWorktrees[]>(() =>
    groupWorktreesByDirectory(projectScopes(), allWorktrees(), scopeLabel),
  )

  const totalCount = createMemo(() => grouped().reduce((sum, group) => sum + group.worktrees.length, 0))

  async function load() {
    if (!globalSDK.connected()) return
    setLoading(true)
    try {
      const scopes = projectScopes()
      const results = await Promise.all(
        scopes.map(async (scope) => {
          const result = await globalSDK.client.worktree.list({ directory: scope.worktree })
          return {
            directory: scope.worktree,
            items: Array.isArray(result.data) ? result.data : [],
          }
        }),
      )
      const next = new Map<string, Worktree[]>()
      for (const { directory, items } of results) next.set(directory, items)
      setAllWorktrees(next)
    } catch (error) {
      setAllWorktrees(new Map())
      showToast({
        type: "error",
        title: "Worktrees failed to load",
        description: errorMessage(error, "Try again."),
      })
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    refreshKey()
    if (!globalSDK.connected()) return
    void untrack(() => load())
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
        description: errorMessage(error, "Try again."),
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
            <span class="text-text-weak text-12-medium">
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
              Refresh
            </Button>
          </div>

          <SettingsEntityList
            isEmpty={!loading() && totalCount() === 0}
            emptyIcon={getSemanticIcon("workspace.worktree")}
            emptyTitle="No worktrees found"
            emptyDescription="Managed worktrees will appear here once created."
          >
            <For each={grouped()}>
              {(group) => (
                <Show when={group.worktrees.length > 0}>
                  <div class="flex flex-col gap-2">
                    <div class="text-11-medium uppercase tracking-wider text-text-weaker px-1">{group.scopeLabel}</div>
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
                                  <div class="flex items-center gap-1.5 mt-0.5 text-text-weak text-12-medium">
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
                                  <div class="mt-1 text-12-medium text-text-weaker flex flex-wrap items-center gap-x-2 gap-y-1">
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
