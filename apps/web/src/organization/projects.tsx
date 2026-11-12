import { batch, createSignal, For, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { OrgProjectView } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { usePlatform } from "@/context/platform"
import { WorkspaceError } from "./workspace-error"
import { organizationWorkspaceMessages as messages } from "./workspace-messages"
import { OrganizationKnowledge } from "./knowledge"
import { OrganizationArtifacts } from "./artifacts"
import { OrganizationProjectMembers } from "./project-members"
import { OrganizationLocalProject } from "./local-project"
import { OrganizationSessions } from "./sessions"
import { organizationSessionMessages } from "./session-messages"
import { organizationOwnerFailure } from "./owner-error"

export function OrganizationProjects() {
  const space = useSpace()
  const { _ } = useLingui()
  const confirm = useConfirm()
  const platform = usePlatform()
  const api = space.client()!
  const view = space.current()!
  const route = space.route()
  const projectID = route?.kind === "organization" ? route.projectID : undefined
  const projectView = route?.kind === "organization" ? route.view : undefined
  const conversation = route?.kind === "organization" && !!route.sessionID
  const [state, setState] = createStore<{ projects: OrgProjectView[]; project?: OrgProjectView }>({ projects: [] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  let editor: AbortController | undefined
  let generation = 0
  let editorGeneration = 0
  const [blocked, setBlocked] = createSignal(false)
  const current = (version = generation) => !signal.aborted && space.current() === view && version === generation
  const options = { throwOnError: true, signal } as const
  onCleanup(() => {
    controller.abort()
    editor?.abort()
  })
  function closeEditor() {
    editorGeneration++
    editor?.abort()
    editor = undefined
    setBusy(false)
    setCreating(false)
    setEditing(false)
  }
  function edit(project?: OrgProjectView) {
    if (blocked() || !current() || (projectID && !state.project?.permissions.manage)) return
    closeEditor()
    editor = new AbortController()
    setName(project?.name ?? "")
    setDescription(project?.description ?? "")
    setCreating(!project)
    setEditing(!!project)
  }
  function failed(error: unknown) {
    const failure = organizationOwnerFailure(error)
    batch(() => {
      if (failure) {
        generation++
        confirm.closeOwned()
        closeEditor()
        setBlocked(true)
        setLoading(false)
        setState("projects", reconcile([]))
        setState("project", undefined)
        setCursor(undefined)
        setLoaded(false)
        setEditing(false)
        setCreating(false)
        setName("")
        setDescription("")
      }
      setError(error)
    })
    if (failure === "authentication") space.authorizationRequired(view)
  }

  async function load(more = false) {
    if (loading() || !current()) return
    const version = generation
    setLoading(true)
    setError(undefined)
    try {
      if (projectID) {
        const result = await api.orgProjects.get({ projectID }, options)
        if (!current(version)) return
        batch(() => {
          if (state.project?.permissions.manage && !result.data.permissions.manage) {
            generation++
            confirm.closeOwned()
            closeEditor()
            setName("")
            setDescription("")
            setLoading(false)
          }
          setState("project", reconcile(result.data))
        })
      } else {
        const result = await api.orgProjects.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
        if (!current(version)) return
        setState("projects", reconcile(more ? [...state.projects, ...result.data.items] : result.data.items))
        setCursor(result.data.cursor)
      }
      if (current(version)) {
        setLoaded(true)
        setBlocked(false)
      }
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setLoading(false)
    }
  }
  async function save() {
    if (
      busy() ||
      blocked() ||
      !current() ||
      !editor ||
      (!editing() && !creating()) ||
      (projectID && !state.project?.permissions.manage)
    )
      return
    const version = generation
    const editVersion = editorGeneration
    const request = { name: name().trim(), description: description(), expectedRevision: state.project?.revision }
    const requestSignal = AbortSignal.any([signal, editor.signal])
    const editingCurrent = () => current(version) && editVersion === editorGeneration && !requestSignal.aborted
    setBusy(true)
    setError(undefined)
    try {
      if (projectID) {
        if (request.expectedRevision === undefined) return
        const result = await api.orgProjects.update(
          {
            projectID,
            orgProjectChange: {
              expectedRevision: request.expectedRevision,
              name: request.name,
              description: request.description,
            },
          },
          { throwOnError: true, signal: requestSignal },
        )
        if (editingCurrent()) {
          setState("project", reconcile(result.data))
          closeEditor()
        }
      } else {
        const result = await api.orgProjects.create(
          { orgProjectCreate: { name: request.name, description: request.description } },
          { throwOnError: true, signal: requestSignal },
        )
        if (editingCurrent()) space.project(result.data.projectID)
      }
    } catch (error) {
      if (editingCurrent()) failed(error)
    } finally {
      if (editingCurrent()) setBusy(false)
    }
  }
  function changeLifecycle() {
    const project = state.project
    if (!project?.permissions.manage || blocked() || !current()) return
    const version = generation
    const target = { projectID: project.projectID, revision: project.revision, state: project.state }
    const restoring = target.state === "archived"
    confirm.show({
      title: restoring ? messages.restore : messages.archive,
      description: restoring ? messages.restoreHint : messages.archiveHint,
      confirmLabel: restoring ? messages.restore : messages.archive,
      tone: "warning",
      async onConfirm() {
        if (blocked() || !current(version)) return
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgProjects.update(
            {
              projectID: target.projectID,
              orgProjectChange: { expectedRevision: target.revision, state: restoring ? "active" : "archived" },
            },
            options,
          )
          if (current(version)) setState("project", reconcile(result.data))
        } catch (error) {
          if (current(version)) failed(error)
        } finally {
          if (current(version)) setBusy(false)
        }
      },
    })
  }
  onMount(() => void load())
  const form = () => (
    <form
      class="organization-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <TextField label={_(messages.projectName)} value={name()} onChange={setName} required maxLength={200} autofocus />
      <TextField
        label={_(messages.description)}
        value={description()}
        onChange={setDescription}
        multiline
        maxLength={4000}
      />
      <div class="organization-actions">
        <Button variant="primary" size="large" type="submit" disabled={busy() || !name().trim()}>
          {_(busy() ? messages.working : projectID ? messages.save : messages.createProject)}
        </Button>
        <Button variant="ghost" size="large" type="button" onClick={closeEditor}>
          {_(messages.cancel)}
        </Button>
      </div>
    </form>
  )
  return (
    <section
      class="organization-projects-view"
      classList={{ "organization-projects-view--conversation": conversation }}
    >
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(messages.loading)}</p>
      </Show>
      <Show
        when={projectID}
        fallback={
          <>
            <div class="organization-page-heading">
              <h2>{_(messages.projects)}</h2>
              <Show when={space.connection()?.account.role !== "member" && !creating() && !blocked()}>
                <Button size="large" variant="primary" onClick={() => edit()}>
                  {_(messages.createProject)}
                </Button>
              </Show>
            </div>
            <Show when={creating()}>{form()}</Show>
            <Show when={loaded() && !state.projects.length && !creating()}>
              <div class="organization-empty">
                <Icon name={getSemanticIcon("project.main")} size="large" />
                <h3>{_(messages.emptyProjects)}</h3>
                <p>
                  {_(
                    space.connection()?.account.role === "member"
                      ? messages.emptyMemberProjectsHint
                      : messages.emptyProjectsHint,
                  )}
                </p>
              </div>
            </Show>
            <ul class="organization-project-list">
              <For each={state.projects}>
                {(project) => (
                  <li>
                    <button onClick={() => space.project(project.projectID)}>
                      <span class="organization-project-mark">
                        <Icon name={getSemanticIcon("project.main")} size="normal" />
                      </span>
                      <span class="organization-project-copy">
                        <strong>{project.name}</strong>
                        <span>{project.description}</span>
                      </span>
                      <span class="organization-project-role">
                        {project.state === "archived"
                          ? _(messages.archived)
                          : project.role
                            ? _(messages[project.role])
                            : ""}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={cursor()}>
              <Button disabled={loading()} onClick={() => void load(true)}>
                {_(messages.more)}
              </Button>
            </Show>
          </>
        }
      >
        <Show when={!conversation}>
          <Button variant="ghost" onClick={() => space.project()}>
            {_(messages.back)}
          </Button>
        </Show>
        <Show when={state.project}>
          {(project) => (
            <>
              <Show when={!conversation}>
                <div class="organization-page-heading">
                  <div>
                    <h2>{project().name}</h2>
                    <Show when={project().state === "archived"}>
                      <p>{_(messages.archived)}</p>
                    </Show>
                  </div>
                  <Show when={project().permissions.manage && !editing()}>
                    <div class="organization-actions">
                      <Button onClick={() => edit(project())}>{_(messages.edit)}</Button>
                      <Button disabled={busy()} onClick={changeLifecycle}>
                        {_(project().state === "archived" ? messages.restore : messages.archive)}
                      </Button>
                    </div>
                  </Show>
                </div>
                <Show
                  when={editing()}
                  fallback={<p class="organization-project-description">{project().description}</p>}
                >
                  {form()}
                </Show>
                <nav
                  class="organization-workspace-nav"
                  aria-label={_({ id: "organization.workspace.projectNavigation", message: "Project navigation" })}
                >
                  <Button variant="ghost" data-selected={!projectView} onClick={() => space.project(projectID)}>
                    {_({ id: "organization.workspace.overview", message: "Overview" })}
                  </Button>
                  <Button
                    variant="ghost"
                    data-selected={projectView === "sessions"}
                    onClick={() => space.page("sessions", projectID)}
                  >
                    {_(organizationSessionMessages.conversations)}
                  </Button>
                  <Button
                    variant="ghost"
                    data-selected={projectView === "knowledge"}
                    onClick={() => space.page("knowledge", projectID)}
                  >
                    {_(messages.knowledge)}
                  </Button>
                  <Button
                    variant="ghost"
                    data-selected={projectView === "artifacts"}
                    onClick={() => space.page("artifacts", projectID)}
                  >
                    {_(messages.artifacts)}
                  </Button>
                  <Show when={project().permissions.manage}>
                    <Button
                      variant="ghost"
                      data-selected={projectView === "members"}
                      onClick={() => space.page("members", projectID)}
                    >
                      {_(messages.members)}
                    </Button>
                  </Show>
                </nav>
              </Show>
              <Switch>
                <Match when={projectView === "sessions"}>
                  <OrganizationSessions
                    projectID={projectID!}
                    projectName={project().name}
                    canManage={project().permissions.manage}
                    canExecute={project().permissions.execute}
                  />
                </Match>
                <Match
                  when={
                    !projectView &&
                    project().permissions.execute &&
                    platform.platform === "desktop" &&
                    platform.organization
                  }
                >
                  <OrganizationLocalProject projectID={projectID!} />
                </Match>
                <Match when={projectView === "knowledge"}>
                  <OrganizationKnowledge
                    projectID={projectID}
                    canManage={project().permissions.manage}
                    canExecute={project().permissions.execute}
                  />
                </Match>
                <Match when={projectView === "artifacts"}>
                  <OrganizationArtifacts projectID={projectID!} />
                </Match>
                <Match when={projectView === "members" && project().permissions.manage}>
                  <OrganizationProjectMembers projectID={projectID!} changed={() => void load()} invalidated={failed} />
                </Match>
                <Match when={projectView === "members" && !project().permissions.manage}>
                  <WorkspaceError error={{ code: "PERMISSION_DENIED" }} />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}
