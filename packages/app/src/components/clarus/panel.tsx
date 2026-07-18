import { createMemo, Show, For } from "solid-js"
import { AppPanel } from "@/components/app-panel"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { clarus as S } from "@/locales/messages"
import { useClarus } from "@/context/clarus"
import {
  activateTaskSession,
  buildClarusProjectHierarchy,
  CLARUS_STATUS_ICON,
  connectionStatusDetail,
  connectionStatusLabel,
  hierarchyProjectKey,
  hierarchyTaskKey,
  retainStaleHierarchy,
  taskStatusLabel,
  type ClarusHierarchy,
  type TaskLike,
} from "./hierarchy"

// ---------------------------------------------------------------------------
// ClarusPanel
// ---------------------------------------------------------------------------

export function ClarusPanel(props: { navigateToSession(sessionID: string): void }) {
  const { store, selectProject, selectTask, refreshNavigation } = useClarus()
  const { _ } = useLingui()

  // Build hierarchy from snapshot, preserving last-good data across re-fetches
  const previousHierarchy = createMemo<ClarusHierarchy | null>(
    (prev: ClarusHierarchy | null) => {
      const snap = store.snapshot
      if (!snap) return prev ?? null
      return buildClarusProjectHierarchy(snap.projects, snap.connection.status)
    },
    null as ClarusHierarchy | null,
  )

  const hierarchy = createMemo<ClarusHierarchy | null>(() => {
    const snap = store.snapshot
    if (!snap) return retainStaleHierarchy(null, previousHierarchy())
    const current = buildClarusProjectHierarchy(snap.projects, snap.connection.status)
    return retainStaleHierarchy(current, previousHierarchy())
  })

  const connIcon = createMemo<IconName>(() => {
    const snap = store.snapshot
    if (!snap) return getSemanticIcon(CLARUS_STATUS_ICON.disabled)
    return getSemanticIcon(CLARUS_STATUS_ICON[snap.connection.status] ?? CLARUS_STATUS_ICON.disabled)
  })

  const connLabel = createMemo(() => {
    const snap = store.snapshot
    if (!snap) return _(S.connectionConnecting)
    return connectionStatusLabel(snap.connection.status, _)
  })
  const connDetail = createMemo(() => {
    const snap = store.snapshot
    if (!snap) return
    return connectionStatusDetail(snap.connection.status, snap.connection.error)
  })
  const openTask = (task: Pick<TaskLike, "agentId" | "projectId" | "taskId" | "sessionID" | "status">) =>
    activateTaskSession(task, {
      selectTask,
      navigateToSession: props.navigateToSession,
    })

  return (
    <AppPanel.Root>
      <AppPanel.Content>
        <AppPanel.Header>
          <AppPanel.HeaderRow>
            <AppPanel.Title>{_(S.title)}</AppPanel.Title>
          </AppPanel.HeaderRow>
          <AppPanel.Subtitle>{_(S.subtitle)}</AppPanel.Subtitle>
          <AppPanel.Actions>
            <AppPanel.Action
              icon={getSemanticIcon("action.refresh")}
              label={_(S.refresh)}
              onClick={() => refreshNavigation()}
            />
          </AppPanel.Actions>
        </AppPanel.Header>
        <AppPanel.Body>
          {/* Full loading state — only when no snapshot exists yet */}
          <Show when={store.loading && !store.snapshot}>
            <div class="flex items-center justify-center py-12">
              <Spinner />
            </div>
          </Show>

          {/* Error state — only when no snapshot to fall back on */}
          <Show when={store.error && !store.snapshot}>
            <div class="flex flex-col items-center gap-3 py-12 text-text-weak">
              <Icon name={getSemanticIcon("state.error")} size="large" class="text-icon-critical-base" />
              <span class="text-13-medium">{_(S.loadFailed)}</span>
              <span class="text-12-regular">{store.error}</span>
              <button
                type="button"
                class="text-13-medium text-icon-interactive-base hover:text-text-strong transition-colors"
                onClick={() => refreshNavigation()}
              >
                {_(S.retry)}
              </button>
            </div>
          </Show>

          {/* Empty — no hierarchy after stale fallback exhausted */}
          <Show when={!store.loading && !hierarchy()}>
            <div class="flex flex-col items-center gap-2 py-12 text-text-weak">
              <Icon name={getSemanticIcon("state.empty")} size="large" />
              <span class="text-13-medium">{_(S.noNavigation)}</span>
            </div>
          </Show>

          {/* Hierarchy content */}
          <Show when={hierarchy()}>
            {(h: () => ClarusHierarchy) => (
              <div class="flex flex-col gap-4">
                {/* Connection status bar */}
                <div class="flex items-center gap-2 px-1 py-1">
                  <Icon name={connIcon()} size="small" />
                  <span class="text-12-regular text-text-weaker">{connLabel()}</span>
                  <Show when={connDetail()}>
                    {(detail) => <span class="text-11-regular text-text-weaker">{detail()}</span>}
                  </Show>
                  <Show when={store.stale}>
                    <span class="text-11-regular text-text-weaker italic">{_(S.stale)}</span>
                  </Show>
                </div>

                {/* Active projects */}
                <Show when={h().activeProjects.length > 0}>
                  <div class="flex flex-col gap-0.5">
                    <div class="text-11-medium text-text-weaker px-1 pt-2 pb-1.5 uppercase tracking-wide">
                      {_(S.active)}
                    </div>
                    <For each={h().activeProjects}>
                      {(project) => (
                        <div class="flex flex-col">
                          <button
                            type="button"
                            classList={{
                              "flex items-center gap-2 px-2.5 py-2 rounded-lg text-13-medium transition-colors w-full text-left": true,
                              "workbench-selected-surface bg-surface-raised-base text-text-strong shadow-sm":
                                store.selectedProjectKey === hierarchyProjectKey(project),
                              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                                store.selectedProjectKey !== hierarchyProjectKey(project),
                            }}
                            onClick={() => selectProject(hierarchyProjectKey(project))}
                          >
                            <Icon name={getSemanticIcon("clarus.project")} size="small" class="shrink-0" />
                            <span class="flex-1 truncate">{project.projectName}</span>
                          </button>
                          <Show when={store.selectedProjectKey === hierarchyProjectKey(project)}>
                            <div class="pl-4 pr-2 pb-1 flex flex-col gap-0.5">
                              <Show when={project.tasks.length === 0}>
                                <div class="px-2.5 py-2 text-12-regular text-text-weaker italic">{_(S.noTasks)}</div>
                              </Show>
                              <For each={project.tasks}>
                                {(task) => (
                                  <button
                                    type="button"
                                    classList={{
                                      "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-12-regular transition-colors w-full text-left": true,
                                      "bg-surface-raised-base text-text-strong":
                                        store.selectedTaskKey === hierarchyTaskKey(task),
                                      "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                                        store.selectedTaskKey !== hierarchyTaskKey(task),
                                    }}
                                    onClick={() => openTask(task)}
                                  >
                                    <Icon name={getSemanticIcon("clarus.task")} size="small" class="shrink-0" />
                                    <span class="flex-1 truncate">{task.title}</span>
                                    <span class="text-11-regular text-text-weaker shrink-0">
                                      {taskStatusLabel(task.status, task.resultState, _)}
                                    </span>
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Inactive projects with history */}
                <Show when={h().inactiveProjectsWithHistory.length > 0}>
                  <div class="flex flex-col gap-0.5">
                    <div class="text-11-medium text-text-weaker px-1 pt-4 pb-1.5 uppercase tracking-wide">
                      {_(S.history)}
                    </div>
                    <For each={h().inactiveProjectsWithHistory}>
                      {(project) => (
                        <div class="flex flex-col">
                          <button
                            type="button"
                            classList={{
                              "flex items-center gap-2 px-2.5 py-2 rounded-lg text-13-medium transition-colors w-full text-left opacity-60 hover:opacity-80": true,
                              "workbench-selected-surface bg-surface-raised-base text-text-strong shadow-sm":
                                store.selectedProjectKey === hierarchyProjectKey(project),
                              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                                store.selectedProjectKey !== hierarchyProjectKey(project),
                            }}
                            onClick={() => selectProject(hierarchyProjectKey(project))}
                          >
                            <Icon name={getSemanticIcon("clarus.project")} size="small" class="shrink-0" />
                            <span class="flex-1 truncate">{project.projectName}</span>
                          </button>
                          <Show when={store.selectedProjectKey === hierarchyProjectKey(project)}>
                            <div class="pl-4 pr-2 pb-1 flex flex-col gap-0.5">
                              <For each={project.tasks}>
                                {(task) => (
                                  <button
                                    type="button"
                                    classList={{
                                      "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-12-regular transition-colors w-full text-left": true,
                                      "bg-surface-raised-base text-text-strong":
                                        store.selectedTaskKey === hierarchyTaskKey(task),
                                      "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                                        store.selectedTaskKey !== hierarchyTaskKey(task),
                                    }}
                                    onClick={() => openTask(task)}
                                  >
                                    <Icon name={getSemanticIcon("clarus.task")} size="small" class="shrink-0" />
                                    <span class="flex-1 truncate">{task.title}</span>
                                    <span class="text-11-regular text-text-weaker shrink-0">
                                      {taskStatusLabel(task.status, task.resultState, _)}
                                    </span>
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                {/* No projects at all */}
                <Show when={h().activeProjects.length === 0 && h().inactiveProjectsWithHistory.length === 0}>
                  <div class="flex flex-col items-center gap-2 py-8 text-text-weak">
                    <Icon name={getSemanticIcon("state.empty")} size="large" />
                    <span class="text-12-regular">{_(S.noProjects)}</span>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
