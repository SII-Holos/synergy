import { batch, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type {
  OrgKnowledgeItem,
  OrgKnowledgeRelease,
  OrgKnowledgeSelectionSummary,
  OrgKnowledgeSelectionPage,
  OrgKnowledgeStatus,
  OrgPublicationFile,
} from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"
import { PublicationEditor } from "./publication-editor"
import { PublicationFiles } from "./publication-files"
import { publicationMessages as messages } from "./publication-messages"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { createKnowledgeUpdate } from "./knowledge-update"
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
    applied?: OrgKnowledgeSelectionSummary
    selected?: OrgKnowledgeSelectionSummary
    appliedReferences: OrgKnowledgeSelectionPage["items"]
    selectedReferences: OrgKnowledgeSelectionPage["items"]
    status?: OrgKnowledgeStatus
  }>({ items: [], appliedReferences: [], selectedReferences: [] })
  const ledger = createKnowledgeUpdate(
    localStorage,
    view.key,
    `${props.projectID ?? "organization"}:${props.sessionID ?? "project"}`,
  )
  const [pending, setPending] = createSignal<ReturnType<typeof ledger.pending>>()
  const [referencesBusy, setReferencesBusy] = createSignal(false)
  let referencesRevision = 0
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
        referencesRevision++
        setBlocked(true)
        setState(
          reconcile({
            items: [],
            applied: undefined,
            selected: undefined,
            appliedReferences: [],
            selectedReferences: [],
            status: undefined,
          }),
        )
        setCursor(undefined)
        setSelected(undefined)
        setPublishing(false)
        setQ("")
        setQuery("")
        setPending(undefined)
        setReferencesBusy(false)
        setStatusBusy(false)
        setLoading(false)
        setBusy(false)
        setLoaded(false)
      }
      setError(error)
    })
    if (failure === "authentication") space.authorizationRequired(view)
  }
  function storeReferences(target: "applied" | "selected", page: OrgKnowledgeSelectionPage, itemIDs: string[]) {
    if (page.selection.revision < (state[target]?.revision ?? 0)) return
    const key = target === "applied" ? "appliedReferences" : "selectedReferences"
    const previous = state[target]?.manifestHash === page.selection.manifestHash ? state[key] : []
    const requested = new Set(itemIDs)
    setState(
      key,
      reconcile([...previous.filter((entry) => !requested.has(entry.itemID)), ...page.items], { key: "itemID" }),
    )
    setState(target, reconcile(page.selection))
  }
  async function selectionReferences(itemIDs: string[]) {
    const ownerVersion = generation
    const version = ++referencesRevision
    const ids = [...new Set(itemIDs)]
    const pages = ids.length
      ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, (index + 1) * 100))
      : [[]]
    setReferencesBusy(true)
    try {
      for (const ids of pages) {
        const [applied, selected] = await Promise.all([
          props.projectID
            ? api.orgKnowledge.appliedReferences({ projectID: props.projectID, itemIDs: ids }, options)
            : undefined,
          props.sessionID
            ? api.orgKnowledge.sessionSelectionReferences({ sessionID: props.sessionID, itemIDs: ids }, options)
            : undefined,
        ])
        if (!current(ownerVersion) || version !== referencesRevision) return
        if (applied) storeReferences("applied", applied.data, ids)
        if (selected) storeReferences("selected", selected.data, ids)
      }
    } finally {
      if (current(ownerVersion) && version === referencesRevision) setReferencesBusy(false)
    }
  }
  async function load(more = false) {
    if (loading() || !current()) return
    const version = generation
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
      if (!current(version)) return
      setBlocked(false)
      setPending(ledger.pending())
      setState("items", reconcile(more ? [...state.items, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setLoaded(true)
      await selectionReferences(result.data.items.map((item) => item.itemID))
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setLoading(false)
    }
  }
  async function apply(release: OrgKnowledgeRelease, target: "project" | "session", remove = false) {
    const version = generation
    const selection = target === "project" ? state.applied : state.selected
    if (
      !current() ||
      blocked() ||
      busy() ||
      pending() ||
      referencesBusy() ||
      !selection ||
      !props.projectID ||
      (target === "session" && !props.sessionID)
    )
      return
    try {
      ledger.begin({
        requestID: generateUUID(),
        target:
          target === "project"
            ? { kind: "member", projectID: props.projectID }
            : { kind: "session", sessionID: props.sessionID! },
        expectedRevision: selection.revision,
        change: {
          itemID: release.itemID,
          ...(remove
            ? {}
            : { reference: { itemID: release.itemID, version: release.version, manifestHash: release.manifestHash } }),
        },
      })
      setPending(ledger.pending())
      await resume()
    } catch (error) {
      if (current(version)) failed(error)
    }
  }
  async function resume() {
    if (busy() || blocked() || !current()) return
    const version = generation
    setBusy(true)
    setError(undefined)
    try {
      const request = ledger.pending()
      if (!request) return
      const summary = await ledger.execute(api, signal)
      if (!current(version)) return
      setPending(undefined)
      setState(request.target.kind === "member" ? "applied" : "selected", reconcile(summary))
      await selectionReferences([request.change.itemID])
      if (props.sessionID) await status()
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) {
        setBusy(false)
        setPending(ledger.pending())
      }
    }
  }
  async function status() {
    if (!props.sessionID || statusBusy() || blocked() || !current()) return
    const version = generation
    setStatusBusy(true)
    try {
      const result = await api.orgKnowledge.status({ sessionID: props.sessionID }, options)
      if (current(version)) setState("status", reconcile(result.data))
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setStatusBusy(false)
    }
  }
  onMount(() => {
    try {
      setPending(ledger.pending())
    } catch (error) {
      setError(error)
    }
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
        <Show when={props.canManage && !blocked() && !publishing()}>
          <Button
            ref={(element: HTMLButtonElement) => {
              publicationTrigger = element
            }}
            size="large"
            variant="primary"
            onClick={() => {
              setSelected(undefined)
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
        <Show when={pending()}>
          <div class="organization-workspace-error" role="status">
            <p>
              {_({
                id: "organization.knowledge.pendingUpdate",
                message:
                  "A knowledge change is awaiting confirmation. Retry the same change before submitting another.",
              })}
            </p>
            <Button disabled={busy()} onClick={() => void resume()}>
              {_(common.retry)}
            </Button>
          </div>
        </Show>
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
            invalidated={failed}
            titleRef={(element) => {
              publicationTitle = element
            }}
            purpose="knowledge"
            scope={props.projectID ? { kind: "project", projectID: props.projectID } : { kind: "organization" }}
            cancel={() => {
              setPublishing(false)
              if (current() && !blocked()) publicationTrigger?.focus()
            }}
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
        <Show when={loaded() && !state.items.length && !publishing()}>
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
                  onClick={async () => {
                    setPublishing(false)
                    setSelected(selected() === item.itemID ? undefined : item.itemID)
                    const version = generation
                    if (selected())
                      try {
                        await selectionReferences([item.itemID])
                      } catch (error) {
                        if (current(version)) failed(error)
                      }
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
                    invalidated={failed}
                    item={item}
                    canManage={props.canManage}
                    canExecute={props.canExecute}
                    selectionMode={props.selectionMode}
                    runtimeOwnerID={props.runtimeOwnerID}
                    projectID={props.projectID}
                    sessionID={props.sessionID}
                    busy={busy() || !!pending() || referencesBusy()}
                    applied={state.appliedReferences.find((entry) => entry.itemID === item.itemID)?.version}
                    selected={state.selectedReferences.find((entry) => entry.itemID === item.itemID)?.version}
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
      </Show>
    </section>
  )
}

function KnowledgeDetail(props: {
  invalidated: (error: unknown) => void
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
  let publicationTitle: HTMLInputElement | undefined
  let publicationTrigger: HTMLButtonElement | undefined
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
      if (!signal.aborted) {
        if (organizationOwnerFailure(error)) props.invalidated(error)
        else setError(error)
      }
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
          if (!signal.aborted) {
            if (organizationOwnerFailure(error)) props.invalidated(error)
            else setError(error)
          }
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
            <KnowledgeFiles release={version} invalidated={props.invalidated} />
          </>
        )}
      </Show>
      <Show when={managing()}>
        <div class="organization-actions">
          <Show when={!publishing()}>
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
          <Button onClick={withdraw}>{_(messages.withdraw)}</Button>
        </div>
      </Show>
      <Show when={publishing()}>
        <PublicationEditor
          invalidated={props.invalidated}
          titleRef={(element) => {
            publicationTitle = element
          }}
          purpose="knowledge"
          scope={props.item.scope}
          existing={{
            id: props.item.itemID,
            revision: props.item.revision,
            title: props.item.title,
            kind: props.item.kind,
          }}
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

function KnowledgeFiles(props: { release: OrgKnowledgeRelease; invalidated: (error: unknown) => void }) {
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
      <PublicationFiles
        invalidated={props.invalidated}
        files={state.files}
        target={{ kind: "knowledge", itemID: props.release.itemID, version: props.release.version }}
        loading={loading()}
        more={cursor() ? () => void load() : undefined}
      />
    </>
  )
}
