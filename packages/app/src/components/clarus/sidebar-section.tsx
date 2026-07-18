import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalNavigateToSession } from "@/composables/use-global-navigate-to-session"
import { useClarus } from "@/context/clarus"
import { useLingui } from "@lingui/solid"
import { clarus as S } from "@/locales/messages"
import {
  activateTaskSession,
  buildClarusProjectHierarchy,
  hierarchyProjectKey,
  taskStatusLabel,
  type TaskLike,
} from "./hierarchy"
import { handleDisclosureKeyDown } from "./keyboard"

export function ClarusSidebarSection(props: { activeSessionID?: string }) {
  const { store, selectProject, selectTask } = useClarus()
  const { _ } = useLingui()
  const navigateToSession = useGlobalNavigateToSession()
  const [open, setOpen] = createSignal(true)
  const [expandedProjectKey, setExpandedProjectKey] = createSignal<string>()

  const hierarchy = createMemo(() => {
    const snapshot = store.snapshot
    if (!snapshot) return
    return buildClarusProjectHierarchy(snapshot.projects, snapshot.connection.status)
  })

  const projects = createMemo(() => {
    const value = hierarchy()
    if (!value) return []
    return [...value.activeProjects, ...value.inactiveProjectsWithHistory]
  })

  const openTask = (task: Pick<TaskLike, "agentId" | "projectId" | "taskId" | "sessionID" | "status">) =>
    activateTaskSession(task, { selectTask, navigateToSession })

  return (
    <div class="sb-clarus sb-root-section">
      <div
        class="sb-projects-header"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => handleDisclosureKeyDown(event, open(), setOpen)}
        role="button"
        tabindex="0"
      >
        <span class="sb-section-title">{_(S.title)}</span>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
      </div>
      <Show when={open()}>
        <Show when={store.snapshot} fallback={<div class="sb-section-empty">{_(S.loading)}</div>}>
          <Show when={projects().length > 0} fallback={<div class="sb-section-empty">{_(S.noClarusProjects)}</div>}>
            <For each={projects()}>
              {(project) => {
                const projectKey = hierarchyProjectKey(project)
                const expanded = () => expandedProjectKey() === projectKey
                return (
                  <div
                    class="sb-project-group"
                    data-clarus-agent-id={project.agentId}
                    data-clarus-project-id={project.projectId}
                  >
                    <div
                      classList={{
                        "sb-project-row": true,
                        "sb-project-expanded": expanded(),
                      }}
                    >
                      <button
                        type="button"
                        class="sb-project-chevron-btn"
                        aria-label={_(expanded() ? S.collapseProject : S.expandProject)}
                        aria-expanded={expanded()}
                        onClick={() => {
                          const next = expanded() ? undefined : projectKey
                          setExpandedProjectKey(next)
                          if (next) selectProject(next)
                        }}
                      >
                        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                      </button>
                      <button
                        type="button"
                        class="sb-project-body"
                        onClick={() => {
                          const next = expanded() ? undefined : projectKey
                          setExpandedProjectKey(next)
                          if (next) selectProject(next)
                        }}
                      >
                        <Icon name={getSemanticIcon("clarus.project")} size="normal" class="sb-project-folder" />
                        <span class="sb-project-name">{project.projectName}</span>
                      </button>
                    </div>
                    <Show when={expanded()}>
                      <Show
                        when={project.tasks.length > 0}
                        fallback={<div class="sb-section-empty sb-clarus-project-empty">{_(S.noTasks)}</div>}
                      >
                        <div class="sb-sessions">
                          <For each={project.tasks}>
                            {(task) => (
                              <button
                                type="button"
                                classList={{
                                  "sb-session-row": true,
                                  "sb-session-active": props.activeSessionID === task.sessionID,
                                }}
                                data-session-id={task.sessionID}
                                onClick={() => openTask(task)}
                              >
                                <span class="sb-session-icon-wrap">
                                  <Icon name={getSemanticIcon("clarus.task")} size="small" class="sb-session-icon" />
                                </span>
                                <span class="sb-session-title">{task.title}</span>
                                <span class="sb-clarus-task-status">
                                  {taskStatusLabel(task.status, task.resultState, _)}
                                </span>
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
