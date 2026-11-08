import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { OrganizationIdentity } from "@ericsanchezok/synergy-organization-protocol"
import type { OrgProjectView } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { SpaceSwitcher } from "@/components/sidebar/space-switcher"
import { organizationSpaceMessages as messages } from "./space-messages"
import "./space-page.css"

export function SpaceAccess() {
  const platform = usePlatform()
  return (
    <div class="organization-space-footer">
      <SpaceSwitcher expanded onRepository={() => platform.openLink("https://github.com/SII-Holos/synergy")} />
    </div>
  )
}

function connectionError(error: unknown): keyof typeof messages {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "origin_not_allowed") return "originNotAllowed"
  if (code === "invalid_request") return "invalidRequest"
  if (code === "storage_unavailable" || code === "credentials_unavailable" || code === "credentials_invalid")
    return "storage"
  if (code === "identity_changed" || code === "invalid_response") return "identityChanged"
  if (code === "popup_unavailable") return "popup"
  if (code === "secure_context_required") return "secure"
  if (code === "sign_out_pending") return "signOutPending"
  return "unavailable"
}

export function OrganizationSpace() {
  const space = useSpace()
  const { _ } = useLingui()
  const confirm = useConfirm()
  onMount(() => window.dispatchEvent(new Event("synergy:app-surface-ready")))
  const title = () => space.connection()?.name ?? space.connection()?.issuer ?? _(messages.connect)
  function signOut() {
    const key = space.selected()
    if (!key) return
    confirm.show({
      title: messages.signOut,
      description: messages.signOutDescription,
      confirmLabel: messages.signOut,
      tone: "warning",
      onConfirm: () => {
        void space.signOut(key).catch(() => {})
      },
    })
  }
  return (
    <div class="organization-space">
      <header class="organization-space-header">
        <div>
          <p class="organization-space-brand">{_({ id: "app.name.synergy", message: "Synergy" })}</p>
          <h1>{title()}</h1>
          <Show when={space.connection()}>
            {(entry) => (
              <p class="organization-space-account">
                {entry().account.displayName} · {entry().account.loginName}
              </p>
            )}
          </Show>
        </div>
        <Show when={space.connection()?.state === "ready"}>
          <Button variant="ghost" onClick={signOut}>
            {_(messages.signOut)}
          </Button>
        </Show>
      </header>
      <main class="organization-space-content">
        <Show when={space.error()}>
          {(error) => (
            <p role="alert" class="organization-space-error">
              {_(messages[connectionError(error())])}
            </p>
          )}
        </Show>
        <Show
          when={space.selected() === "connect"}
          fallback={
            <Show
              when={space.connection()}
              fallback={
                <div class="organization-space-state">
                  <h2>{_(messages.missing)}</h2>
                  <Button onClick={space.add}>{_(messages.connect)}</Button>
                </div>
              }
            >
              {(entry) => (
                <Show
                  when={space.current()?.identity.kind === "organization" && space.current()}
                  keyed
                  fallback={
                    <div class="organization-space-state">
                      <h2>
                        {_(
                          entry().state === "sign_out_pending"
                            ? messages.signOutPending
                            : entry().state === "signed_out"
                              ? messages.signedOut
                              : messages.disconnected,
                        )}
                      </h2>
                      <Button
                        disabled={space.busy()}
                        onClick={() => {
                          const key = space.selected()!
                          void (entry().state === "sign_out_pending" ? space.signOut(key) : space.restore(key)).catch(
                            () => {},
                          )
                        }}
                      >
                        {_(
                          space.busy()
                            ? messages.connecting
                            : entry().state === "sign_out_pending"
                              ? messages.finishSignOut
                              : messages.restore,
                        )}
                      </Button>
                    </div>
                  }
                >
                  {(_view) => <Projects />}
                </Show>
              )}
            </Show>
          }
        >
          <Connect />
        </Show>
      </main>
      <SpaceAccess />
    </div>
  )
}

function Connect() {
  const space = useSpace()
  const { _ } = useLingui()
  const [issuer, setIssuer] = createSignal(space.origins.length === 1 ? space.origins[0]! : "")
  const [clientID, setClientID] = createSignal("")
  const [failed, setFailed] = createSignal(false)
  return (
    <form
      class="organization-space-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (space.busy()) return
        setFailed(false)
        void space
          .connect({ issuer: issuer().trim().replace(/\/+$/, ""), clientID: clientID().trim() })
          .catch(() => setFailed(true))
      }}
    >
      <h2>{_(messages.connect)}</h2>
      <Show when={!space.desktop && !space.origins.length}>
        <p role="alert">{_(messages.originNotAllowed)}</p>
      </Show>
      <Show when={failed() && !space.error()}>
        <p role="alert">{_(messages.unavailable)}</p>
      </Show>
      <fieldset disabled={space.busy()}>
        <TextField
          label={_(messages.address)}
          value={issuer()}
          onChange={setIssuer}
          type="url"
          required
          autocomplete="url"
        />
        <TextField label={_(messages.client)} value={clientID()} onChange={setClientID} required autocomplete="off" />
        <p>{_(messages.clientHint)}</p>
        <Button type="submit" disabled={!space.desktop && !space.origins.length}>
          {_(space.busy() ? messages.connecting : messages.connect)}
        </Button>
      </fieldset>
    </form>
  )
}

function Projects() {
  const space = useSpace()
  const { _ } = useLingui()
  const api = space.client()!
  const view = space.current()!
  const route = space.route()
  const projectID = route?.kind === "organization" ? route.projectID : undefined
  const [state, setState] = createStore({
    projects: [] as OrgProjectView[],
    project: undefined as OrgProjectView | undefined,
  })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal(false)
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const current = () => !disposed && !view.signal.aborted
  async function load(more = false) {
    if (loading() || !current()) return
    setLoading(true)
    setError(false)
    try {
      const result = projectID
        ? await api.orgProjects.get({ projectID }, { throwOnError: true })
        : await api.orgProjects.list({ limit: 50, cursor: more ? cursor() : undefined }, { throwOnError: true })
      if (!current()) return
      if (projectID) {
        const project = OrganizationIdentity.ProjectView.parse(result.data)
        if (project.orgID !== space.connection()?.orgID || project.projectID !== projectID)
          throw new Error("Project identity changed")
        setState("project", reconcile(project))
      } else {
        const page = OrganizationIdentity.ProjectPage.parse(result.data)
        if (page.items.some((project) => project.orgID !== space.connection()?.orgID))
          throw new Error("Project identity changed")
        const combined = more ? [...state.projects, ...page.items] : page.items
        setState("projects", reconcile([...new Map(combined.map((project) => [project.projectID, project])).values()]))
        setCursor(page.cursor)
      }
      setLoaded(true)
    } catch {
      if (current()) setError(true)
    } finally {
      if (current()) setLoading(false)
    }
  }
  onMount(() => {
    void load()
    void api.orgOrganization
      .get({ throwOnError: true })
      .then((response) => {
        if (!current()) return
        const organization = OrganizationIdentity.Organization.parse(response.data)
        if (organization.orgID === space.connection()?.orgID) space.name(view.key, organization.name)
      })
      .catch(() => {})
  })
  const role = (project: OrgProjectView) =>
    project.role ? _(messages[project.role]) : project.permissions.manage ? _(messages.manage) : ""
  return (
    <section class="organization-projects" aria-label={_(messages.projects)}>
      <Show when={projectID} fallback={<h2>{_(messages.projects)}</h2>}>
        <Button variant="ghost" onClick={() => space.project()}>
          {_(messages.back)}
        </Button>
      </Show>
      <Show when={error()}>
        <div role="alert">
          <p>{_(messages.projectFailed)}</p>
          <Button onClick={() => void load()}>{_(messages.retry)}</Button>
        </div>
      </Show>
      <Show when={loading()}>
        <p role="status">{_(messages.loading)}</p>
      </Show>
      <Show when={state.project}>
        {(project) => (
          <article class="organization-project-detail">
            <h2>{project().name}</h2>
            <p>{role(project())}</p>
            <Show when={project().state === "archived"}>
              <p>{_(messages.archived)}</p>
            </Show>
            <p class="organization-project-description">{project().description}</p>
          </article>
        )}
      </Show>
      <Show when={!projectID && loaded() && !state.projects.length}>
        <p>{_(messages.empty)}</p>
      </Show>
      <ul class="organization-project-list">
        <For each={state.projects}>
          {(project) => (
            <li>
              <button onClick={() => space.project(project.projectID)}>
                <span>
                  <strong>{project.name}</strong>
                  <span>{project.description}</span>
                </span>
                <span class="organization-project-role">
                  {project.state === "archived" ? _(messages.archived) : role(project)}
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
    </section>
  )
}
