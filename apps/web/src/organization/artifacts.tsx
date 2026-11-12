import { batch, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrgArtifactVersion, OrgPublicationFile } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useSpace } from "@/context/space"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"
import { PublicationEditor } from "./publication-editor"
import { PublicationFiles } from "./publication-files"
import { publicationMessages as messages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./publication.css"

export function OrganizationArtifacts(props: { projectID: string; sessionID?: string; canPublish?: boolean }) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore({ items: [] as OrgArtifactVersion[] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [selected, setSelected] = createSignal<string>()
  const [publishing, setPublishing] = createSignal(false)
  let publicationTitle: HTMLInputElement | undefined
  let publicationTrigger: HTMLButtonElement | undefined
  const [blocked, setBlocked] = createSignal(false)
  let generation = 0
  const current = (version = generation) => !signal.aborted && version === generation
  function failed(error: unknown) {
    const failure = organizationOwnerFailure(error)
    batch(() => {
      if (failure) {
        generation++
        setBlocked(true)
        setState("items", reconcile([]))
        setCursor(undefined)
        setSelected(undefined)
        setPublishing(false)
        setLoaded(false)
        setLoading(false)
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
      const result = await api.orgArtifacts.list(
        { projectID: props.projectID, limit: 50, cursor: more ? cursor() : undefined },
        options,
      )
      if (!current(version)) return
      setBlocked(false)
      setState("items", reconcile(more ? [...state.items, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setLoaded(true)
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setLoading(false)
    }
  }
  function published() {
    setPublishing(false)
    setSelected(undefined)
    void load()
  }
  onMount(() => void load())
  return (
    <section class="organization-artifacts-view">
      <div class="organization-page-heading">
        <div>
          <h2>{_(messages.artifacts)}</h2>
          <p>{_(messages.artifactHint)}</p>
        </div>
        <Show when={props.sessionID && props.canPublish && !blocked() && !publishing()}>
          <Button
            ref={(element: HTMLButtonElement) => {
              publicationTrigger = element
            }}
            size="large"
            variant="primary"
            onClick={() => {
              setPublishing(true)
              publicationTitle?.focus()
            }}
          >
            {_(messages.publish)}
          </Button>
        </Show>
      </div>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={!blocked()}>
        <Show when={publishing()}>
          <PublicationEditor
            invalidated={failed}
            titleRef={(element) => {
              publicationTitle = element
            }}
            purpose="artifact"
            scope={{ kind: "project", projectID: props.projectID }}
            sourceSessionID={props.sessionID}
            cancel={() => {
              setPublishing(false)
              if (current() && !blocked()) publicationTrigger?.focus()
            }}
            published={published}
          />
        </Show>
        <Show when={loaded() && !state.items.length && !publishing()}>
          <div class="organization-empty">
            <h3>{_(messages.empty)}</h3>
          </div>
        </Show>
        <ul class="organization-publication-list">
          <For each={state.items}>
            {(item) => (
              <li>
                <button
                  class="organization-publication-entry"
                  data-selected={selected() === item.artifactID}
                  aria-expanded={selected() === item.artifactID}
                  onClick={() => setSelected(selected() === item.artifactID ? undefined : item.artifactID)}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <span>
                      {new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium" }).format(item.publishedAt)}
                    </span>
                  </span>
                  <span>{_({ ...messages.version, values: { version: item.version } })}</span>
                </button>
                <Show when={selected() === item.artifactID}>
                  <ArtifactDetail
                    invalidated={failed}
                    item={item}
                    sessionID={props.sessionID}
                    canPublish={props.canPublish}
                    updated={published}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={cursor()}>
          <Button disabled={loading()} onClick={() => void load(true)}>
            {_(common.more)}
          </Button>
        </Show>
      </Show>
    </section>
  )
}

function ArtifactDetail(props: {
  invalidated: (error: unknown) => void
  item: OrgArtifactVersion
  sessionID?: string
  canPublish?: boolean
  updated: () => void
}) {
  const space = useSpace()
  const api = space.client()!
  const { _ } = useLingui()
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const [state, setState] = createStore({ versions: [] as OrgArtifactVersion[] })
  const [cursor, setCursor] = createSignal<number>()
  const [release, setRelease] = createSignal<OrgArtifactVersion>()
  const [error, setError] = createSignal<unknown>()
  const [loading, setLoading] = createSignal(false)
  const [publishing, setPublishing] = createSignal(false)
  let publicationTitle: HTMLInputElement | undefined
  let publicationTrigger: HTMLButtonElement | undefined
  async function load(more = false) {
    setLoading(true)
    try {
      const result = await api.orgArtifacts.versions(
        { artifactID: props.item.artifactID, limit: 20, cursor: more ? cursor() : undefined },
        { throwOnError: true, signal },
      )
      if (signal.aborted) return
      setState("versions", reconcile(more ? [...state.versions, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      if (!release()) setRelease(result.data.items[0])
    } catch (error) {
      if (!signal.aborted) {
        if (organizationOwnerFailure(error)) props.invalidated(error)
        else setError(error)
      }
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  return (
    <div class="organization-publication-detail">
      <WorkspaceError error={error()} retry={() => void load()} />
      <div class="organization-actions">
        <h3>{_(messages.versions)}</h3>
        <For each={state.versions}>
          {(version) => (
            <Button
              data-selected={release()?.version === version.version}
              aria-pressed={release()?.version === version.version}
              onClick={() => setRelease(version)}
            >
              {_({ ...messages.version, values: { version: version.version } })}
            </Button>
          )}
        </For>
        <Show when={cursor()}>
          <Button disabled={loading()} onClick={() => void load(true)}>
            {_(common.more)}
          </Button>
        </Show>
      </div>
      <Show when={release()} keyed>
        {(version) => (
          <>
            <p>
              {version.author
                ? _({ ...messages.authorName, values: { name: version.author.displayName } })
                : _({ ...messages.author, values: { author: version.authorID } })}
            </p>
            <Show
              when={version.sourceAvailable && version.sourceSessionID}
              fallback={<p>{_(messages.sourceUnavailable)}</p>}
            >
              <Button onClick={() => space.page("sessions", version.projectID, version.sourceSessionID)}>
                {_(messages.source)}
              </Button>
            </Show>
            <ArtifactFiles release={version} invalidated={props.invalidated} />
          </>
        )}
      </Show>
      <Show when={props.canPublish && props.sessionID && !publishing()}>
        <Button
          ref={(element: HTMLButtonElement) => {
            publicationTrigger = element
          }}
          onClick={() => {
            setPublishing(true)
            publicationTitle?.focus()
          }}
        >
          {_(messages.publishVersion)}
        </Button>
      </Show>
      <Show when={publishing()}>
        <PublicationEditor
          invalidated={props.invalidated}
          titleRef={(element) => {
            publicationTitle = element
          }}
          purpose="artifact"
          scope={{ kind: "project", projectID: props.item.projectID }}
          sourceSessionID={props.sessionID}
          existing={{ id: props.item.artifactID, title: props.item.title, revision: props.item.revision }}
          cancel={() => {
            setPublishing(false)
            if (!signal.aborted) publicationTrigger?.focus()
          }}
          published={props.updated}
        />
      </Show>
    </div>
  )
}

function ArtifactFiles(props: { release: OrgArtifactVersion; invalidated: (error: unknown) => void }) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const [state, setState] = createStore({ files: [] as OrgPublicationFile[] })
  const [cursor, setCursor] = createSignal<string>()
  const [error, setError] = createSignal<unknown>()
  const [loading, setLoading] = createSignal(false)
  const [reference, setReference] = createSignal<string>()
  async function load() {
    if (loading()) return
    setLoading(true)
    try {
      const result = await api.orgArtifacts.reference(
        { artifactID: props.release.artifactID, version: props.release.version, limit: 50, cursor: cursor() },
        { throwOnError: true, signal },
      )
      if (signal.aborted) return
      setState("files", reconcile([...state.files, ...result.data.files]))
      setCursor(result.data.cursor)
      setReference(
        JSON.stringify({
          artifactID: result.data.artifactID,
          version: result.data.version,
          manifestHash: result.data.manifestHash,
          projectID: result.data.projectID,
        }),
      )
    } catch (error) {
      if (!signal.aborted) {
        if (organizationOwnerFailure(error)) props.invalidated(error)
        else setError(error)
      }
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  return (
    <>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={reference()}>
        <TextField label={_(messages.reference)} value={reference()} copyable readOnly />
      </Show>
      <PublicationFiles
        invalidated={props.invalidated}
        files={state.files}
        target={{ kind: "artifact", artifactID: props.release.artifactID, version: props.release.version }}
        loading={loading()}
        more={cursor() ? () => void load() : undefined}
      />
    </>
  )
}
