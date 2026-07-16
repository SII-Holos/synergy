import { createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalNavigateToSession } from "@/composables/use-global-navigate-to-session"
import { useClarus } from "@/context/clarus"
import { activateTaskSession, buildClarusProjectHierarchy, EMPTY_PROJECT_TASKS_TEXT } from "./hierarchy"

export function ClarusSidebarSection(props: { activeSessionID?: string }) {
  const { store, selectProject, selectTask } = useClarus()
  const navigateToSession = useGlobalNavigateToSession()
  const [open, setOpen] = createSignal(true)
  const [expandedProjectId, setExpandedProjectId] = createSignal<string>()

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

  const openTask = (task: { taskId: string; sessionID: string; status: string }) =>
    activateTaskSession(task, { selectTask, navigateToSession })

  return (
    <div class="sb-clarus sb-root-section">
      <div class="sb-projects-header" onClick={() => setOpen((value) => !value)} role="button" tabindex="0">
        <span class="sb-section-title">Clarus</span>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" class="sb-section-chevron" />
      </div>
      <Show when={open()}>
        <Show when={store.snapshot} fallback={<div class="sb-section-empty">Loading Clarus…</div>}>
          <Show when={projects().length > 0} fallback={<div class="sb-section-empty">No Clarus projects</div>}>
            <For each={projects()}>
              {(project) => {
                const expanded = () => expandedProjectId() === project.projectId
                return (
                  <div class="sb-project-group" data-clarus-project-id={project.projectId}>
                    <div
                      classList={{
                        "sb-project-row": true,
                        "sb-project-expanded": expanded(),
                      }}
                    >
                      <button
                        type="button"
                        class="sb-project-chevron-btn"
                        aria-label={expanded() ? "Collapse Clarus project" : "Expand Clarus project"}
                        aria-expanded={expanded()}
                        onClick={() => {
                          const next = expanded() ? undefined : project.projectId
                          setExpandedProjectId(next)
                          if (next) selectProject(next)
                        }}
                      >
                        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                      </button>
                      <button
                        type="button"
                        class="sb-project-body"
                        onClick={() => {
                          const next = expanded() ? undefined : project.projectId
                          setExpandedProjectId(next)
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
                        fallback={
                          <div class="sb-section-empty sb-clarus-project-empty">{EMPTY_PROJECT_TASKS_TEXT}</div>
                        }
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
                                <span class="sb-clarus-task-status">{task.status}</span>
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
