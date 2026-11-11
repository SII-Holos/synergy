import { createSignal, For, onMount, Show, Switch, Match } from "solid-js"
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
  const current = () => !view.signal.aborted
  const options = { throwOnError: true, signal: view.signal } as const

  async function load(more = false) {
    if (loading() || !current()) return
    setLoading(true)
    setError(undefined)
    try {
      if (projectID) {
        const result = await api.orgProjects.get({ projectID }, options)
        if (current()) setState("project", reconcile(result.data))
      } else {
        const result = await api.orgProjects.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
        if (!current()) return
        setState("projects", reconcile(more ? [...state.projects, ...result.data.items] : result.data.items))
        setCursor(result.data.cursor)
      }
      if (current()) setLoaded(true)
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setLoading(false)
    }
  }
  async function save() {
    if (busy() || !current()) return
    setBusy(true)
    setError(undefined)
    try {
      if (projectID && state.project) {
        const result = await api.orgProjects.update(
          {
            projectID,
            orgProjectChange: {
              expectedRevision: state.project.revision,
              name: name().trim(),
              description: description(),
            },
          },
          options,
        )
        if (current()) {
          setState("project", reconcile(result.data))
          setEditing(false)
        }
      } else {
        const result = await api.orgProjects.create(
          { orgProjectCreate: { name: name().trim(), description: description() } },
          options,
        )
        if (current()) space.project(result.data.projectID)
      }
    } catch (error) {
      if (current()) setError(error)
    } finally {
      if (current()) setBusy(false)
    }
  }
  function changeLifecycle() {
    const project = state.project
    if (!project) return
    const restoring = project.state === "archived"
    confirm.show({
      title: restoring ? messages.restore : messages.archive,
      description: restoring ? messages.restoreHint : messages.archiveHint,
      confirmLabel: restoring ? messages.restore : messages.archive,
      tone: "warning",
      async onConfirm() {
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgProjects.update(
            {
              projectID: project.projectID,
              orgProjectChange: { expectedRevision: project.revision, state: restoring ? "active" : "archived" },
            },
            options,
          )
          if (current()) setState("project", reconcile(result.data))
        } catch (error) {
          if (current()) setError(error)
        } finally {
          if (current()) setBusy(false)
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
        <Button
          variant="ghost"
          size="large"
          type="button"
          onClick={() => {
            setCreating(false)
            setEditing(false)
          }}
        >
          {_(messages.cancel)}
        </Button>
      </div>
    </form>
  )
  return (
    <section class="organization-projects-view">
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
              <Show when={space.connection()?.account.role !== "member" && !creating()}>
                <Button
                  size="large"
                  variant="primary"
                  onClick={() => {
                    setCreating(true)
                    setName("")
                    setDescription("")
                  }}
                >
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
        <Button variant="ghost" onClick={() => space.project()}>
          {_(messages.back)}
        </Button>
        <Show when={state.project}>
          {(project) => (
            <>
              <div class="organization-page-heading">
                <div>
                  <h2>{project().name}</h2>
                  <Show when={project().state === "archived"}>
                    <p>{_(messages.archived)}</p>
                  </Show>
                </div>
                <Show when={project().permissions.manage && !editing()}>
                  <div class="organization-actions">
                    <Button
                      onClick={() => {
                        setName(project().name)
                        setDescription(project().description)
                        setEditing(true)
                      }}
                    >
                      {_(messages.edit)}
                    </Button>
                    <Button disabled={busy()} onClick={changeLifecycle}>
                      {_(project().state === "archived" ? messages.restore : messages.archive)}
                    </Button>
                  </div>
                </Show>
              </div>
              <Show when={editing()} fallback={<p class="organization-project-description">{project().description}</p>}>
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
              <Switch>
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
                  <OrganizationProjectMembers projectID={projectID!} changed={() => void load()} />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}
