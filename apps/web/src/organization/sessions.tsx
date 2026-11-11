import { createSignal, createMemo, createEffect, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type {
  OrganizationSessionProtocol as Session,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import type { OrgSessionResourceContract } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { organizationOwnerFailure } from "./owner-error"
import { OrganizationSessionCreate } from "./session-create"
import { OrganizationSessionComposer } from "./session-composer"
import { OrganizationSessionResources } from "./session-resources"
import { OrganizationSessionInteractions } from "./interactions"
import { OrganizationKnowledge } from "./knowledge"
import { OrganizationArtifacts } from "./artifacts"
import { SharedOrganizationTranscript } from "./shared-transcript"
import { PrivateOrganizationTranscript } from "./private-transcript"
import { createOrganizationSessionReader } from "./private-read"
import { OrganizationTasks, organizationTaskMessages as tasks } from "./tasks"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./session.css"

export function OrganizationSessions(props: {
  projectID: string
  projectName: string
  canManage: boolean
  canExecute: boolean
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const route = space.route()
  const sessionID = route?.kind === "organization" ? route.sessionID : undefined
  const [state, setState] = createStore({ sessions: [] as Session.View[] })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  async function load(more = false) {
    if (loading() || sessionID) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgSessions.list(
        { projectID: props.projectID, limit: 50, cursor: more ? cursor() : undefined },
        { throwOnError: true, signal: view.signal },
      )
      if (view.signal.aborted) return
      setState("sessions", reconcile(more ? [...state.sessions, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setLoaded(true)
    } catch (error) {
      if (!view.signal.aborted) setError(error)
    } finally {
      if (!view.signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  return (
    <Show
      when={sessionID}
      fallback={
        <section class="organization-session-view">
          <div class="organization-page-heading">
            <h2>{_(messages.conversations)}</h2>
            <Show when={props.canExecute}>
              <Button variant="primary" size="large" onClick={() => setCreating(true)}>
                {_(messages.new)}
              </Button>
            </Show>
          </div>
          <WorkspaceError error={error()} retry={() => void load()} />
          <Show when={creating()}>
            <OrganizationSessionCreate projectID={props.projectID} cancel={() => setCreating(false)} />
          </Show>
          <Show when={loading()}>
            <p role="status">{_(common.loading)}</p>
          </Show>
          <Show when={loaded() && !state.sessions.length && !creating()}>
            <div class="organization-empty">
              <h3>{_(messages.empty)}</h3>
              <p>{_(messages.emptyHint)}</p>
            </div>
          </Show>
          <ul class="organization-session-list">
            <For each={state.sessions}>
              {(session) => (
                <li>
                  <button
                    class="organization-publication-entry"
                    onClick={() => space.page("sessions", props.projectID, session.sessionID)}
                  >
                    <span>
                      <strong>
                        {session.title ??
                          _(session.shareState === "private" ? messages.private : messages.conversations)}
                      </strong>
                      <span>
                        {_({
                          ...messages.created,
                          values: {
                            date: new Intl.DateTimeFormat(i18n().locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(session.createdAt),
                          },
                        })}
                      </span>
                    </span>
                    <span>{_(session.shareState === "private" ? messages.private : messages.shared)}</span>
                  </button>
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
      }
    >
      {(id) => (
        <OrganizationSessionPage
          sessionID={id()}
          projectID={props.projectID}
          projectName={props.projectName}
          canManage={props.canManage}
        />
      )}
    </Show>
  )
}

function OrganizationSessionPage(props: {
  sessionID: string
  projectID: string
  projectName: string
  canManage: boolean
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const confirm = useConfirm()
  const platform = usePlatform()
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore<{
    session?: Session.View
    share?: Sync.Share
    resources?: OrgSessionResourceContract
  }>({})
  const [error, setError] = createSignal<unknown>()
  const [busy, setBusy] = createSignal(false)
  const [tab, setTab] = createSignal<"conversation" | "tasks" | "resources" | "knowledge" | "artifacts">("conversation")
  const [nativeTitle, setNativeTitle] = createSignal<string>()
  const [nativeStatus, setNativeStatus] = createSignal<Sync.Status>()
  const [selectedTask, setSelectedTask] = createSignal<Sync.TaskSummary>()
  const [taskUnavailable, setTaskUnavailable] = createSignal(false)
  const sourceID = () => selectedTask()?.sessionID ?? props.sessionID
  const binding = createMemo(
    () =>
      state.session && {
        schemaVersion: 1 as const,
        orgID: space.connection()!.orgID,
        projectID: state.session.projectID,
        creatorID: state.session.creatorID,
        driverRuntimeID: state.session.driverRuntimeID,
        bindingEpoch: state.session.bindingEpoch,
      },
  )
  const bindingKey = createMemo(() => JSON.stringify(binding()))
  const reader = createMemo(
    on(bindingKey, (key) => {
      const captured = binding()
      if (!captured) return
      const controller = new AbortController()
      const current = AbortSignal.any([signal, controller.signal])
      const connection = space.connection()!
      const read = createOrganizationSessionReader({
        api,
        bridge: platform.organization,
        connectionID: connection.transport === "desktop" ? connection.id : undefined,
        binding: captured,
        signal: current,
        authorizationRequired: () => space.authorizationRequired(view),
      })
      onCleanup(() => controller.abort())
      return { key, binding: captured, signal: current, read }
    }),
  )
  createEffect(() => {
    bindingKey()
    setNativeStatus(undefined)
    setNativeTitle(undefined)
    setSelectedTask(undefined)
    setTaskUnavailable(false)
  })
  createEffect(
    on(
      () => [reader(), state.share?.shareState] as const,
      ([captured, shareState]) => {
        if (!captured || shareState !== "private") return
        const controller = new AbortController()
        const current = AbortSignal.any([captured.signal, controller.signal])
        let timer: ReturnType<typeof setTimeout> | undefined
        async function observe() {
          try {
            const [session, status] = await Promise.all([
              captured!.read({ operation: "session", rootSessionID: props.sessionID }, current),
              captured!.read({ operation: "status", rootSessionID: props.sessionID }, current),
            ])
            if (current.aborted || captured !== reader()) return
            if (session.operation === "session") setNativeTitle(session.session.title)
            if (status.operation === "status") setNativeStatus(status.status)
          } catch (error) {
            if (!current.aborted && captured === reader()) invalidated(error)
          }
          if (!current.aborted)
            timer = setTimeout(() => void observe(), document.visibilityState === "visible" ? 5000 : 15000)
        }
        void observe()
        onCleanup(() => {
          controller.abort()
          if (timer) clearTimeout(timer)
        })
      },
    ),
  )
  function sourceFailure(error: unknown, captured: ReturnType<typeof reader>, source: string) {
    if (!captured || captured.signal.aborted || captured !== reader() || source !== sourceID()) return
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (source !== props.sessionID && code === "NOT_FOUND") {
      setSelectedTask(undefined)
      setTaskUnavailable(true)
      return
    }
    invalidated(error)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let unavailable = false
  function invalidated(error: unknown) {
    if (signal.aborted || !organizationOwnerFailure(error)) return
    unavailable = true
    revision++
    if (timer) clearTimeout(timer)
    setState(reconcile({}))
    setError(error)
    if (organizationOwnerFailure(error) === "authentication") space.authorizationRequired(view)
  }
  async function load() {
    if (unavailable) return
    const version = ++revision
    try {
      const [session, share, resources] = await Promise.all([
        api.orgSessions.get({ sessionID: props.sessionID }, options),
        api.orgSessions.shareState({ sessionID: props.sessionID }, options),
        api.orgSessionResources.get({ sessionID: props.sessionID }, options),
      ])
      if (signal.aborted || version !== revision) return
      setState("session", reconcile(session.data))
      setState("share", reconcile(share.data))
      setState("resources", reconcile(resources.data))
      setError(undefined)
    } catch (error) {
      if (signal.aborted || version !== revision) return
      if (organizationOwnerFailure(error)) invalidated(error)
      else setError(error)
    }
  }
  async function poll() {
    await load()
    if (!signal.aborted && !unavailable)
      timer = setTimeout(() => void poll(), document.visibilityState === "visible" ? 5000 : 15000)
  }
  function retry() {
    if (timer) clearTimeout(timer)
    unavailable = false
    void poll()
  }
  function sharing() {
    const share = state.share
    if (!share || busy()) return
    const makingPrivate = share.shareState === "shared"
    confirm.show({
      title: makingPrivate ? messages.unshare : messages.share,
      description: makingPrivate ? messages.unshareHint : messages.shareHint,
      confirmLabel: makingPrivate ? messages.unshare : messages.share,
      tone: "warning",
      async onConfirm() {
        setBusy(true)
        setError(undefined)
        try {
          const parameters = {
            sessionID: props.sessionID,
            orgShareChange: { expectedShareGeneration: share.shareGeneration },
          }
          const result = makingPrivate
            ? await api.orgSessions.unshare(parameters, options)
            : await api.orgSessions.share(parameters, options)
          if (!signal.aborted) {
            setState("share", reconcile(result.data))
            await load()
          }
        } catch (error) {
          if (!signal.aborted) setError(error)
        } finally {
          if (!signal.aborted) setBusy(false)
        }
      },
    })
  }
  onMount(() => void poll())
  onCleanup(() => {
    controller.abort()
    if (timer) clearTimeout(timer)
  })
  const observedControl = () => {
    const status = state.session?.shareState === "private" ? nativeStatus() : state.session?.status
    return status
      ? {
          ...(status.type === "paused" ? { pausedSince: status.since } : {}),
          runID: status.runID,
          controlVersion: status.controlVersion,
        }
      : undefined
  }
  return (
    <section class="organization-session-view organization-session-view--detail">
      <WorkspaceError error={error()} retry={retry} />
      <Show when={state.session}>
        {(session) => (
          <>
            <div class="organization-page-heading">
              <div class="organization-session-title">
                <Show
                  when={selectedTask()}
                  fallback={
                    <Button variant="ghost" onClick={() => space.page("sessions", props.projectID)}>
                      {props.projectName} / {_(messages.conversations)}
                    </Button>
                  }
                >
                  {(task) => (
                    <div class="organization-session-source">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelectedTask(undefined)
                          setTaskUnavailable(false)
                          setTab("conversation")
                        }}
                      >
                        {_(tasks.main)}
                      </Button>
                      <strong title={task().description}>{task().description}</strong>
                    </div>
                  )}
                </Show>
                <h2>
                  {session().title ??
                    nativeTitle() ??
                    _(session().shareState === "private" ? messages.private : messages.conversations)}
                </h2>
              </div>
              <Show when={session().creatorID === space.connection()?.account.accountID}>
                <Button disabled={busy()} onClick={sharing}>
                  {_(state.share?.shareState === "shared" ? messages.unshare : messages.share)}
                </Button>
              </Show>
            </div>
            <div class="organization-session-status">
              <span>{_(session().runtime?.state === "online" ? messages.online : messages.offline)}</span>
              <span>{_(session().shareState === "private" ? messages.private : messages.shared)}</span>
              <Show when={state.share?.syncState === "synced"}>
                <span>
                  {_({
                    ...messages.lastSync,
                    values: {
                      date: new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(
                        state.share!.updatedAt,
                      ),
                    },
                  })}
                </span>
              </Show>
              <Show when={state.share?.shareState === "shared" && state.share?.syncState !== "synced"}>
                <span>
                  {_(
                    state.share?.syncState === "failed" || state.share?.syncState === "blocked"
                      ? messages.syncFailed
                      : messages.syncPending,
                  )}
                </span>
              </Show>
            </div>
            <nav class="organization-workspace-nav" aria-label={_(messages.conversations)}>
              <For each={["conversation", "tasks", "resources", "knowledge", "artifacts"] as const}>
                {(value) => (
                  <Button variant="ghost" data-selected={tab() === value} onClick={() => setTab(value)}>
                    {_(
                      value === "conversation"
                        ? messages.conversations
                        : value === "tasks"
                          ? tasks.tasks
                          : common[value],
                    )}
                  </Button>
                )}
              </For>
            </nav>
            <Show when={taskUnavailable()}>
              <p role="status">
                {_({ id: "organization.tasks.unavailable", message: "This task is no longer available." })}
              </p>
            </Show>
            <Switch>
              <Match when={tab() === "conversation"}>
                <div class="organization-session-chat">
                  <Show when={session().permissions.execute && !state.resources?.selection?.modelResourceID}>
                    <p>{_(messages.modelRequired)}</p>
                    <Button onClick={() => setTab("resources")}>{_(messages.chooseResources)}</Button>
                  </Show>
                  <Show
                    when={
                      state.share?.shareState === "shared" &&
                      `${bindingKey()}:${sourceID()}:${state.share.shareGeneration}`
                    }
                    keyed
                  >
                    {(_generation) => {
                      const captured = reader()
                      const source = sourceID()
                      return (
                        <SharedOrganizationTranscript
                          sessionID={props.sessionID}
                          sourceSessionID={source}
                          shareGeneration={state.share!.shareGeneration}
                          invalidated={(error) => sourceFailure(error, captured, source)}
                        />
                      )
                    }}
                  </Show>
                  <Show
                    when={state.share?.shareState === "private" && reader() && `${bindingKey()}:${sourceID()}`}
                    keyed
                  >
                    {(_binding) => {
                      const captured = reader()!
                      const source = sourceID()
                      return (
                        <PrivateOrganizationTranscript
                          sessionID={props.sessionID}
                          sourceSessionID={source}
                          binding={captured.binding}
                          read={captured.read}
                          invalidated={(error) => sourceFailure(error, captured, source)}
                        />
                      )
                    }}
                  </Show>
                  <Show when={session().permissions.stop && reader() && `${bindingKey()}:${sourceID()}`} keyed>
                    {(_binding) => {
                      const captured = reader()!
                      const source = sourceID()
                      return (
                        <OrganizationSessionInteractions
                          sessionID={props.sessionID}
                          sourceSessionID={source}
                          binding={captured.binding}
                          online={session().runtime?.state === "online"}
                          invalidated={(error) => sourceFailure(error, captured, source)}
                        />
                      )
                    }}
                  </Show>
                  <Show when={session().permissions.execute || session().permissions.stop}>
                    <OrganizationSessionComposer
                      session={session()}
                      online={session().runtime?.state === "online"}
                      modelReady={!!state.resources?.selection?.modelResourceID}
                      messageLabel={selectedTask() ? _(tasks.rootMessage) : undefined}
                      control={observedControl()}
                      accepted={() => void load()}
                    />
                  </Show>
                </div>
              </Match>
              <Match when={tab() === "tasks"}>
                <Show
                  when={
                    reader() &&
                    `${bindingKey()}:${sourceID()}:${state.share?.shareState}:${state.share?.shareGeneration}`
                  }
                  keyed
                >
                  {(_source) => {
                    const captured = reader()!
                    const source = sourceID()
                    return (
                      <OrganizationTasks
                        sessionID={props.sessionID}
                        sourceSessionID={source}
                        binding={captured.binding}
                        read={captured.read}
                        shareGeneration={state.share?.shareState === "shared" ? state.share.shareGeneration : undefined}
                        invalidated={(error) => sourceFailure(error, captured, source)}
                        open={(task) => {
                          if (
                            captured.signal.aborted ||
                            captured !== reader() ||
                            source !== sourceID() ||
                            task.parentSessionID !== source
                          )
                            return
                          setSelectedTask(task)
                          setTaskUnavailable(false)
                          setTab("conversation")
                        }}
                      />
                    )
                  }}
                </Show>
              </Match>
              <Match when={tab() === "resources"}>
                <OrganizationSessionResources
                  sessionID={props.sessionID}
                  projectID={props.projectID}
                  canExecute={session().permissions.execute}
                  changed={() => void load()}
                />
              </Match>
              <Match when={tab() === "knowledge"}>
                <OrganizationKnowledge
                  projectID={props.projectID}
                  sessionID={props.sessionID}
                  canManage={props.canManage}
                  canExecute={session().permissions.execute}
                  selectionMode={session().runtime?.runtimeKind}
                  runtimeOwnerID={session().runtime?.ownerID}
                />
              </Match>
              <Match when={tab() === "artifacts"}>
                <OrganizationArtifacts
                  projectID={props.projectID}
                  sessionID={props.sessionID}
                  canPublish={session().permissions.execute}
                />
              </Match>
            </Switch>
          </>
        )}
      </Show>
    </section>
  )
}
