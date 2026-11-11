import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type {
  OrgKnowledgeItem,
  OrgKnowledgeRelease,
  OrgKnowledgeSelection,
  OrgKnowledgeStatus,
  OrgPublicationFile,
} from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { PublicationEditor } from "./publication-editor"
import { PublicationFiles } from "./publication-files"
import { publicationMessages as messages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./publication.css"

export function OrganizationKnowledge(props: {
  projectID?: string
  sessionID?: string
  canManage?: boolean
  canExecute?: boolean
  selectionMode?: "member" | "hosted"
  runtimeOwnerID?: string
}) {
  const space = useSpace()
  const { _ } = useLingui()
  const view = space.current()!
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore<{
    items: OrgKnowledgeItem[]
    applied?: OrgKnowledgeSelection
    selected?: OrgKnowledgeSelection
    status?: OrgKnowledgeStatus
  }>({ items: [] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [statusBusy, setStatusBusy] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [q, setQ] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const [publishing, setPublishing] = createSignal(false)
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      const result = query().trim()
        ? await api.orgKnowledge.search(
            { projectID: props.projectID, q: query().trim(), limit: 50, cursor: more ? cursor() : undefined },
            options,
          )
        : await api.orgKnowledge.list(
            { projectID: props.projectID, limit: 50, cursor: more ? cursor() : undefined },
            options,
          )
      if (signal.aborted) return
      setState("items", reconcile(more ? [...state.items, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setLoaded(true)
      if (!more && props.projectID) {
        const result = await api.orgKnowledge.applied({ projectID: props.projectID }, options)
        if (!signal.aborted) setState("applied", reconcile(result.data))
      }
      if (!more && props.sessionID) {
        const result = await api.orgKnowledge.sessionSelection({ sessionID: props.sessionID }, options)
        if (!signal.aborted) setState("selected", reconcile(result.data))
      }
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  async function apply(release: OrgKnowledgeRelease, target: "project" | "session", remove = false) {
    const current = target === "project" ? state.applied : state.selected
    if (busy() || !current || !props.projectID || (target === "session" && !props.sessionID)) return
    setBusy(true)
    setError(undefined)
    const releases = current.releases.filter((entry) => entry.itemID !== release.itemID)
    if (!remove) releases.push({ itemID: release.itemID, version: release.version, manifestHash: release.manifestHash })
    try {
      const result =
        target === "project"
          ? await api.orgKnowledge.apply(
              { projectID: props.projectID, expectedRevision: current.revision, releases },
              options,
            )
          : await api.orgKnowledge.setSessionSelection(
              { sessionID: props.sessionID!, expectedRevision: current.revision, releases },
              options,
            )
      if (!signal.aborted) setState(target === "project" ? "applied" : "selected", reconcile(result.data))
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  async function status() {
    if (!props.sessionID || statusBusy()) return
    setStatusBusy(true)
    try {
      const result = await api.orgKnowledge.status({ sessionID: props.sessionID }, options)
      if (!signal.aborted) setState("status", reconcile(result.data))
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setStatusBusy(false)
    }
  }
  onMount(() => {
    void load()
    if (props.sessionID) {
      void status()
      const timer = setInterval(() => void status(), 5000)
      onCleanup(() => clearInterval(timer))
    }
  })
  return (
    <section class="organization-knowledge-view">
      <div class="organization-page-heading">
        <div>
          <h2>{_(messages.knowledge)}</h2>
          <p>
            {_(
              props.sessionID
                ? props.selectionMode === "member"
                  ? messages.memberSelectionHint
                  : messages.independentHint
                : messages.publishHint,
            )}
          </p>
        </div>
        <Show when={props.canManage}>
          <Button
            size="large"
            variant="primary"
            onClick={() => {
              setSelected(undefined)
              setPublishing(true)
            }}
          >
            {_(messages.publish)}
          </Button>
        </Show>
      </div>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={state.status}>
        {(value) => (
          <section class="organization-selection-status" aria-live="polite">
            <p>{_({ ...messages.desiredSelection, values: { revision: value().desired.revision } })}</p>
            <Show when={value().activated}>
              {(active) => <p>{_({ ...messages.activeSelection, values: { revision: active().revision } })}</p>}
            </Show>
            <Show when={value().state !== "active"}>
              <p>{_(value().state === "failed" ? messages.activationFailed : messages.activationPending)}</p>
              <Show when={value().state === "failed" && value().activated}>
                <p>{_(messages.previousActive)}</p>
              </Show>
              <Button onClick={() => void status()}>{_(messages.refreshStatus)}</Button>
            </Show>
          </section>
        )}
      </Show>
      <Show when={publishing()}>
        <PublicationEditor
          purpose="knowledge"
          scope={props.projectID ? { kind: "project", projectID: props.projectID } : { kind: "organization" }}
          cancel={() => setPublishing(false)}
          published={() => {
            setPublishing(false)
            void load()
          }}
        />
      </Show>
      <form
        class="organization-search"
        onSubmit={(event) => {
          event.preventDefault()
          setSelected(undefined)
          setQuery(q())
          void load()
        }}
      >
        <TextField
          label={_(messages.search)}
          hideLabel
          value={q()}
          onChange={setQ}
          maxLength={256}
          placeholder={_(messages.search)}
        />
        <Button type="submit" disabled={loading()}>
          {_(messages.search)}
        </Button>
      </form>
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={loaded() && !state.items.length}>
        <div class="organization-empty">
          <h3>{_(messages.empty)}</h3>
          <p>{_(messages.emptyHint)}</p>
        </div>
      </Show>
      <ul class="organization-publication-list">
        <For each={state.items}>
          {(item) => (
            <li>
              <button
                class="organization-publication-entry"
                data-selected={selected() === item.itemID}
                aria-expanded={selected() === item.itemID}
                onClick={() => {
                  setPublishing(false)
                  setSelected(selected() === item.itemID ? undefined : item.itemID)
                }}
              >
                <span>
                  <strong>{item.title}</strong>
                  <span>{_(item.kind === "skill" ? messages.skill : messages.material)}</span>
                </span>
                <span>{_({ ...messages.version, values: { version: item.latestVersion } })}</span>
              </button>
              <Show when={selected() === item.itemID}>
                <KnowledgeDetail
                  item={item}
                  canManage={props.canManage}
                  canExecute={props.canExecute}
                  selectionMode={props.selectionMode}
                  runtimeOwnerID={props.runtimeOwnerID}
                  projectID={props.projectID}
                  sessionID={props.sessionID}
                  busy={busy()}
                  applied={state.applied?.releases.find((entry) => entry.itemID === item.itemID)?.version}
                  selected={state.selected?.releases.find((entry) => entry.itemID === item.itemID)?.version}
                  apply={apply}
                  updated={() => {
                    setSelected(undefined)
                    void load()
                  }}
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
    </section>
  )
}

function KnowledgeDetail(props: {
  item: OrgKnowledgeItem
  canManage?: boolean
  canExecute?: boolean
  selectionMode?: "member" | "hosted"
  runtimeOwnerID?: string
  projectID?: string
  sessionID?: string
  busy: boolean
  applied?: number
  selected?: number
  apply: (release: OrgKnowledgeRelease, target: "project" | "session", remove?: boolean) => Promise<void>
  updated: () => void
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const confirm = useConfirm()
  const managing = () =>
    props.item.scope.kind === "organization" ? space.connection()?.account.role !== "member" : props.canManage
  const applying = () =>
    props.canExecute &&
    (!props.sessionID ||
      props.selectionMode !== "member" ||
      props.runtimeOwnerID === space.connection()?.account.accountID)
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore({ versions: [] as OrgKnowledgeRelease[] })
  const [cursor, setCursor] = createSignal<number>()
  const [release, setRelease] = createSignal<OrgKnowledgeRelease>()
  const [publishing, setPublishing] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  async function load(more = false) {
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgKnowledge.versions(
        { itemID: props.item.itemID, cursor: more ? cursor() : undefined, limit: 20 },
        options,
      )
      if (signal.aborted) return
      setState("versions", reconcile(more ? [...state.versions, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      if (!release()) setRelease(result.data.items[0])
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  function withdraw() {
    confirm.show({
      title: messages.withdraw,
      description: messages.withdrawHint,
      confirmLabel: messages.withdraw,
      tone: "warning",
      async onConfirm() {
        try {
          await api.orgKnowledge.withdraw({ itemID: props.item.itemID, expectedRevision: props.item.revision }, options)
          if (!signal.aborted) props.updated()
        } catch (error) {
          if (!signal.aborted) setError(error)
        }
      },
    })
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
                : _({ ...messages.author, values: { author: version.authorID } })}{" "}
              ·{" "}
              {new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(
                version.publishedAt,
              )}
            </p>
            <Show when={props.applied}>
              <p>{_({ ...messages.applied, values: { version: props.applied! } })}</p>
            </Show>
            <Show when={props.selected}>
              <p>{_({ ...messages.selectedVersion, values: { version: props.selected! } })}</p>
            </Show>
            <Show when={applying() && props.projectID}>
              <div class="organization-actions">
                <Button
                  disabled={props.busy || props.applied === version.version}
                  onClick={() => void props.apply(version, "project")}
                >
                  {_(props.applied ? messages.update : messages.apply)}
                </Button>
                <Show when={props.applied}>
                  <Button disabled={props.busy} onClick={() => void props.apply(version, "project", true)}>
                    {_(messages.remove)}
                  </Button>
                </Show>
                <Show when={props.sessionID && props.selectionMode === "hosted"}>
                  <Button
                    disabled={props.busy || props.selected === version.version}
                    onClick={() => void props.apply(version, "session")}
                  >
                    {_(messages.select)}
                  </Button>
                  <Show when={props.selected}>
                    <Button disabled={props.busy} onClick={() => void props.apply(version, "session", true)}>
                      {_(messages.unselect)}
                    </Button>
                  </Show>
                </Show>
              </div>
            </Show>
            <KnowledgeFiles release={version} />
          </>
        )}
      </Show>
      <Show when={managing()}>
        <div class="organization-actions">
          <Button onClick={() => setPublishing(!publishing())}>{_(messages.publishVersion)}</Button>
          <Button onClick={withdraw}>{_(messages.withdraw)}</Button>
        </div>
      </Show>
      <Show when={publishing()}>
        <PublicationEditor
          purpose="knowledge"
          scope={props.item.scope}
          existing={{
            id: props.item.itemID,
            revision: props.item.revision,
            title: props.item.title,
            kind: props.item.kind,
          }}
          cancel={() => setPublishing(false)}
          published={props.updated}
        />
      </Show>
    </div>
  )
}

function KnowledgeFiles(props: { release: OrgKnowledgeRelease }) {
  const space = useSpace()
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const [state, setState] = createStore({ files: [] as OrgPublicationFile[] })
  const [cursor, setCursor] = createSignal<string>()
  const [error, setError] = createSignal<unknown>()
  const [loading, setLoading] = createSignal(false)
  async function load() {
    if (loading()) return
    setLoading(true)
    try {
      const result = await api.orgKnowledge.files(
        { itemID: props.release.itemID, version: props.release.version, limit: 50, cursor: cursor() },
        { throwOnError: true, signal },
      )
      if (signal.aborted) return
      setState("files", reconcile([...state.files, ...result.data.items]))
      setCursor(result.data.cursor)
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  return (
    <>
      <WorkspaceError error={error()} />
      <PublicationFiles
        files={state.files}
        target={{ kind: "knowledge", itemID: props.release.itemID, version: props.release.version }}
        loading={loading()}
        more={cursor() ? () => void load() : undefined}
      />
    </>
  )
}
