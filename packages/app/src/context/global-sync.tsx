import {
  type Message,
  type Agent,
  type Session,
  type Part,
  type Config,
  type Scope,
  type FileDiff,
  type Todo,
  type SessionStatus,
  type ProviderListResponse,
  type ProviderAuthResponse,
  type Command,
  type McpStatus,
  type LspStatus,
  type VcsInfo,
  type PermissionRequest,
  type QuestionRequest,
  type CortexTask,
  type AgendaItem,
  type SessionInboxItem,
  createSynergyClient,
} from "@ericsanchezok/synergy-sdk/client"
import { resolveWorkspaceTransition } from "./workspace-transition"
import { planMessagePageApply } from "./session-message-page"
import { shouldRefreshGlobalConfig, type ConfigUpdatedProperties } from "./global-config-sync"
import { LocaleConfigReconciler } from "./locale-config-reconciler"
import { observeWatermark, type Watermark } from "./sync-watermark"
import {
  parseSyncVersion,
  readSyncVersion,
  SyncResourceFreshness,
  type SyncResource,
  type SyncResourceRequest,
} from "./sync-resource-freshness"
import { planBucketEviction } from "./message-eviction"
import { describeToolPartApply } from "./session-sync-plan"
import {
  applyLatestPage,
  reconcileMessage,
  removeMessageFromWindow,
  type MessageWindowMetadata,
  type MessageWindowState,
} from "./session-message-window"
import { nextMessageWindowTotal, nextMessageWindowTotalAfterRemoval } from "./session-message-total"
import type { SessionWorkspace } from "@ericsanchezok/synergy-sdk/client"
import {
  createPlanBlueprintOfferFromPart,
  emptyPlanBlueprintOfferState,
  findLatestPlanBlueprintOfferFromParts,
  isEmptyPlanBlueprintOfferState,
  reducePlanBlueprintOfferState,
  type PlanBlueprintOfferEvent,
  type PlanBlueprintOfferState,
} from "./plan-blueprint-offer"
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { useGlobalSDK } from "./global-sdk"
import { ErrorPage, type InitError } from "../pages/error"
import { AP } from "@/app-i18n"
import { useLingui } from "@lingui/solid"
import {
  batch,
  createEffect,
  createContext,
  createSignal,
  useContext,
  onCleanup,
  onMount,
  type ParentProps,
  Switch,
  Match,
} from "solid-js"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"
import { recordTokenApply } from "@/components/performance/browser-metrics"

type GlobalPaths = {
  home: string
  root: string
  data: string
  config: string
  state: string
  cache: string
  log: string
}

type ScopedPath = {
  state: string
  config: string
  worktree: string
  directory: string
  home: string
}

type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  scopeID: string
  provider: ProviderListResponse
  config: Config
  path: ScopedPath
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  dag: {
    [sessionID: string]: { id: string; content: string; status: string; deps: string[]; assign?: string }[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  planBlueprintOffer: {
    [sessionID: string]: PlanBlueprintOfferState
  }
  inbox: {
    [sessionID: string]: SessionInboxItem[]
  }
  mcp: {
    [name: string]: McpStatus
  }
  lsp: LspStatus[]
  cortex: CortexTask[]
  agenda: AgendaItem[]
  vcs: VcsInfo | undefined
  sessionTotal: number
  message: {
    [sessionID: string]: Message[]
  }
  messageWindow: {
    [sessionID: string]: MessageWindowMetadata
  }
  part: {
    [messageID: string]: Part[]
  }
}

function findSessionByID(sessions: Session[], sessionID: string): Session | undefined {
  const result = Binary.search(sessions, sessionID, (s) => s.id)
  return result.found ? sessions[result.index] : undefined
}

function setPlanBlueprintOfferState(
  store: State,
  setStore: SetStoreFunction<State>,
  sessionID: string,
  state: PlanBlueprintOfferState,
) {
  if (isEmptyPlanBlueprintOfferState(state)) {
    if (!store.planBlueprintOffer[sessionID]) return
    setStore(
      "planBlueprintOffer",
      produce((draft) => {
        delete draft[sessionID]
      }),
    )
    return
  }

  setStore("planBlueprintOffer", sessionID, reconcile(state))
}

export function updatePlanBlueprintOfferState(
  store: State,
  setStore: SetStoreFunction<State>,
  sessionID: string,
  event: PlanBlueprintOfferEvent,
) {
  const current = store.planBlueprintOffer[sessionID] ?? emptyPlanBlueprintOfferState
  setPlanBlueprintOfferState(store, setStore, sessionID, reducePlanBlueprintOfferState(current, event))
}

function capturePlanBlueprintOfferFromPart(store: State, setStore: SetStoreFunction<State>, part: Part) {
  const session = findSessionByID(store.session, part.sessionID)
  const offer = createPlanBlueprintOfferFromPart({
    part,
    sessionID: part.sessionID,
    workflowKind: session?.workflow?.kind,
  })
  if (!offer) return

  updatePlanBlueprintOfferState(store, setStore, part.sessionID, { type: "captured", offer })
}

export function refreshPlanBlueprintOfferFromLoadedParts(
  store: State,
  setStore: SetStoreFunction<State>,
  sessionID: string,
) {
  const session = findSessionByID(store.session, sessionID)
  if (session?.workflow?.kind !== "plan") {
    updatePlanBlueprintOfferState(store, setStore, sessionID, { type: "plan_exited" })
    return
  }

  const offer = findLatestPlanBlueprintOfferFromParts({
    messages: store.message[sessionID] ?? [],
    partsByMessage: store.part,
    sessionID,
    workflowKind: session.workflow.kind,
    state: store.planBlueprintOffer[sessionID] ?? emptyPlanBlueprintOfferState,
  })
  if (!offer) return

  updatePlanBlueprintOfferState(store, setStore, sessionID, { type: "captured", offer })
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    paths: GlobalPaths
    config: Config
    scope: Scope[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
    agenda: AgendaItem[]
  }>({
    ready: false,
    paths: { home: "", root: "", data: "", config: "", state: "", cache: "", log: "" },
    config: {},
    scope: [],
    provider: {
      all: [],
      connected: [],
      default: {},
      configProviders: [],
      catalogProviders: [],
      profiles: {},
      authHealth: {},
      runtimeAvailability: {},
    },
    provider_auth: {},
    agenda: [],
  })

  const children: Record<string, ReturnType<typeof createStore<State>>> = {}
  const instanceRequestConcurrency = 2
  const bootstrapQueue: string[] = []
  const bootstrapQueued = new Set<string>()
  const bootstrapActive = new Set<string>()
  // Bumped on every (re)connect resync so component-level resources that are not
  // in the normalized store — e.g. blueprint loop state, which the server cannot
  // replay after a restart — refetch their state (issue #331).
  const [reconnectVersion, setReconnectVersion] = createSignal(0)
  const resourceFreshness = new SyncResourceFreshness()

  async function runInstanceRequests<T>(
    items: T[],
    run: (item: T) => Promise<unknown>,
    concurrency = instanceRequestConcurrency,
  ) {
    let index = 0
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index]
        index++
        if (item === undefined) continue
        await run(item)
      }
    })
    await Promise.all(workers)
  }

  function createScopedClient(scopeKey: string) {
    return createSynergyClient({
      baseUrl: globalSDK.url,
      ...(isHomeScope(scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }),
      throwOnError: true,
    })
  }

  function scopeRequest(scopeKey: string) {
    return isHomeScope(scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }
  }

  function captureResourceRequest(scopeKey: string, sessionID: string, resource: SyncResource) {
    return resourceFreshness.capture({ scopeKey, sessionID, resource })
  }

  function applyResourceResponse(
    scopeKey: string,
    sessionID: string,
    resource: SyncResource,
    request: SyncResourceRequest,
    headers: Pick<Headers, "get"> | undefined,
    apply: () => void,
  ) {
    const accepted = resourceFreshness.acceptResponse(
      { scopeKey, sessionID, resource },
      request,
      readSyncVersion(headers),
    )
    if (!accepted) return false
    apply()
    return true
  }
  function invalidateResource(scopeKey: string, sessionID: string, resource: SyncResource) {
    resourceFreshness.invalidate({ scopeKey, sessionID, resource })
  }

  function applyResourceEvent(
    scopeKey: string,
    sessionID: string,
    resource: SyncResource,
    event: { epoch?: unknown; seq?: unknown },
    apply: () => void,
  ) {
    const accepted = resourceFreshness.acceptEvent({ scopeKey, sessionID, resource }, parseSyncVersion(event))
    if (!accepted) return false
    apply()
    return true
  }

  function isResourceRequestCurrent(
    scopeKey: string,
    sessionID: string,
    resource: SyncResource,
    request: SyncResourceRequest,
  ) {
    return resourceFreshness.unchanged({ scopeKey, sessionID, resource }, request)
  }

  function scheduleBootstrap(scopeKey: string) {
    if (!scopeKey || !children[scopeKey]) return
    if (bootstrapActive.has(scopeKey) || bootstrapQueued.has(scopeKey)) return
    bootstrapQueued.add(scopeKey)
    bootstrapQueue.push(scopeKey)
    pumpBootstrapQueue()
  }

  function pumpBootstrapQueue() {
    while (bootstrapActive.size < instanceRequestConcurrency) {
      const scopeKey = bootstrapQueue.shift()
      if (!scopeKey) return
      bootstrapQueued.delete(scopeKey)
      if (!children[scopeKey]) continue
      bootstrapActive.add(scopeKey)
      void bootstrapInstance(scopeKey)
        .catch((e) => setGlobalStore("error", e))
        .finally(() => {
          bootstrapActive.delete(scopeKey)
          pumpBootstrapQueue()
        })
    }
  }

  function peekScopeState(scopeKey: string) {
    return children[scopeKey]
  }

  function ensureScopeState(scopeKey: string) {
    if (!scopeKey) console.error("No scope key provided")
    if (!children[scopeKey]) {
      children[scopeKey] = createStore<State>({
        scopeID: "",
        provider: {
          all: [],
          connected: [],
          default: {},
          configProviders: [],
          catalogProviders: [],
          profiles: {},
          authHealth: {},
          runtimeAvailability: {},
        },
        config: {},
        path: { state: "", config: "", worktree: "", directory: "", home: "" },
        status: "loading" as const,
        agent: [],
        command: [],
        session: [],
        session_status: {},
        session_diff: {},
        todo: {},
        dag: {},
        permission: {},
        question: {},
        planBlueprintOffer: {},
        inbox: {},
        mcp: {},
        lsp: [],
        cortex: [],
        agenda: [],
        vcs: undefined,
        sessionTotal: 0,
        message: {},
        messageWindow: {},
        part: {},
      })
      scheduleBootstrap(scopeKey)
    }
    return children[scopeKey]
  }

  function releaseScopeState(scopeKey: string) {
    delete children[scopeKey]
    resourceFreshness.releaseScope(scopeKey)
    bootstrapQueued.delete(scopeKey)
  }

  async function loadAgenda(scopeKey: string) {
    const [_, setStore] = ensureScopeState(scopeKey)
    const sdk = createScopedClient(scopeKey)
    return sdk.agenda
      .list()
      .then((x) =>
        setStore(
          "agenda",
          reconcile(
            (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
            { key: "id" },
          ),
        ),
      )
      .catch((err) => {
        console.error("Failed to load agenda", err)
      })
  }

  async function loadGlobalAgenda() {
    return globalSDK.client.global.agenda
      .list()
      .then((x) => {
        const items = (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id))
        setGlobalStore("agenda", reconcile(items, { key: "id" }))
      })
      .catch((err) => {
        console.error("Failed to load global agenda", err)
      })
  }

  async function loadGlobalConfig() {
    return globalSDK.client.config.global().then((x) => {
      setGlobalStore("config", reconcile(x.data ?? {}))
    })
  }

  async function loadGlobalProviders() {
    return Promise.all([
      globalSDK.client.provider.list().then((x) => {
        const data = x.data!
        setGlobalStore("provider", {
          ...data,
          all: data.all.map((provider) => ({
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
            ),
          })),
        })
      }),
      globalSDK.client.provider.auth().then((x) => {
        setGlobalStore("provider_auth", x.data ?? {})
      }),
    ]).then(() => undefined)
  }

  async function refreshConfig(scopeKey: string) {
    const [_, setStore] = ensureScopeState(scopeKey)
    const sdk = createScopedClient(scopeKey)

    return Promise.all([
      sdk.provider.list().then((x) => {
        const data = x.data!
        setStore("provider", {
          ...data,
          all: data.all.map((provider) => ({
            ...provider,
            models: Object.fromEntries(
              Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
            ),
          })),
        })
      }),
      sdk.app.agents().then((x) => setStore("agent", x.data ?? [])),
      sdk.config.get().then((x) => setStore("config", x.data!)),
      sdk.command.list().then((x) => setStore("command", x.data ?? [])),
    ]).then(() => undefined)
  }

  let refreshAllConfigsTimer: ReturnType<typeof setTimeout> | undefined
  let refreshAllConfigsPromise: Promise<void> | undefined

  function refreshAllConfigs() {
    if (refreshAllConfigsTimer) clearTimeout(refreshAllConfigsTimer)
    if (!refreshAllConfigsPromise) {
      refreshAllConfigsPromise = new Promise<void>((resolve) => {
        refreshAllConfigsTimer = setTimeout(() => {
          refreshAllConfigsTimer = undefined
          const scopeKeys = Object.keys(children)
          Promise.all([loadGlobalProviders(), runInstanceRequests(scopeKeys, (scopeKey) => refreshConfig(scopeKey))])
            .then(() => resolve())
            .catch(() => resolve())
            .finally(() => {
              refreshAllConfigsPromise = undefined
            })
        }, 200)
      })
    }
    return refreshAllConfigsPromise
  }

  let refreshTargetedTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTargetedPromise: Promise<void> | undefined
  let pendingTargets = new Set<string>()

  function refreshTargeted(executed: string[]) {
    for (const t of executed) pendingTargets.add(t)
    if (refreshTargetedTimer) clearTimeout(refreshTargetedTimer)
    if (!refreshTargetedPromise) {
      refreshTargetedPromise = new Promise<void>((resolve) => {
        refreshTargetedTimer = setTimeout(() => {
          refreshTargetedTimer = undefined
          const targets = new Set(pendingTargets)
          pendingTargets = new Set()
          doRefreshTargeted(targets)
            .then(() => resolve())
            .catch(() => resolve())
            .finally(() => {
              refreshTargetedPromise = undefined
            })
        }, 200)
      })
    }
    return refreshTargetedPromise
  }

  async function doRefreshTargeted(targets: Set<string>) {
    const scopeKeys = Object.keys(children)

    const globalPromises: Promise<unknown>[] = []

    if (targets.has("config") || targets.has("provider")) {
      globalPromises.push(loadGlobalProviders())
    }

    const perScopePromise = runInstanceRequests(scopeKeys, async (scopeKey) => {
      const [_, setStore] = ensureScopeState(scopeKey)
      const sdk = createScopedClient(scopeKey)

      const scopePromises: Promise<unknown>[] = []

      if (targets.has("config")) {
        scopePromises.push(sdk.config.get().then((x) => setStore("config", x.data!)))
      }
      if (targets.has("provider") || targets.has("config")) {
        scopePromises.push(
          sdk.provider.list().then((x) => {
            const data = x.data!
            setStore("provider", {
              ...data,
              all: data.all.map((provider) => ({
                ...provider,
                models: Object.fromEntries(
                  Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
                ),
              })),
            })
          }),
        )
      }
      if (targets.has("agent") || targets.has("provider") || targets.has("config")) {
        scopePromises.push(sdk.app.agents().then((x) => setStore("agent", x.data ?? [])))
      }
      if (targets.has("command") || targets.has("mcp") || targets.has("config")) {
        scopePromises.push(sdk.command.list().then((x) => setStore("command", x.data ?? [])))
      }
      if (targets.has("mcp")) {
        scopePromises.push(sdk.mcp.status().then((x) => setStore("mcp", x.data!)))
      }
      if (targets.has("lsp")) {
        scopePromises.push(
          sdk.lsp
            .status()
            .then((x) => setStore("lsp", x.data!))
            .catch(() => {}),
        )
      }

      await Promise.all(scopePromises)
    })

    await Promise.all([...globalPromises, perScopePromise])
  }

  async function loadSessions(scopeKey: string, sdk?: ReturnType<typeof createSynergyClient>) {
    const client = sdk ?? createScopedClient(scopeKey)
    return client.session
      .list({ parentOnly: false })
      .then((x) => {
        const result = x.data!
        const sessions = (result.data ?? []).filter((s) => !!s?.id && !s.time?.archived)
        const scopeState = children[scopeKey]
        if (!scopeState) return
        const [, setStore] = scopeState
        batch(() => {
          setStore("session", reconcile(sessions, { key: "id" }))
          setStore("sessionTotal", result.total)
        })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        if (!sdk) {
          const project = isHomeScope(scopeKey) ? "Home" : getFilename(scopeKey)
          showToast({ type: "error", title: `Failed to load sessions for ${project}`, description: err.message })
        }
      })
  }

  function syncBySession<T extends { id?: string; sessionID?: string }>(
    setStore: (path1: string, path2: string, value: any) => void,
    storeKey: keyof Pick<State, "permission" | "question">,
    currentKeys: Iterable<string>,
    items: T[],
  ) {
    const grouped: Record<string, T[]> = {}
    for (const item of items) {
      if (!item?.id || !item.sessionID) continue
      const existing = grouped[item.sessionID]
      if (existing) {
        existing.push(item)
        continue
      }
      grouped[item.sessionID] = [item]
    }

    batch(() => {
      for (const sessionID of currentKeys) {
        if (grouped[sessionID]) continue
        setStore(storeKey, sessionID, [])
      }
      for (const [sessionID, entries] of Object.entries(grouped)) {
        setStore(
          storeKey,
          sessionID,
          reconcile(
            entries
              .filter((e) => !!e?.id)
              .slice()
              .sort((a, b) => a.id!.localeCompare(b.id!)),
            { key: "id" },
          ),
        )
      }
    })
  }

  const inboxRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const cortexRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const terminalCortexStatuses = new Set(["completed", "error", "cancelled"])

  function refreshInbox(scopeKey: string, sessionID: string) {
    const key = `${scopeKey}:${sessionID}`
    const existing = inboxRefreshTimers.get(key)
    if (existing) clearTimeout(existing)
    inboxRefreshTimers.set(
      key,
      setTimeout(() => {
        inboxRefreshTimers.delete(key)
        const state = children[scopeKey]
        if (!state) return
        const [, setStore] = state
        const sdk = createScopedClient(scopeKey)
        const request = captureResourceRequest(scopeKey, sessionID, "inbox")
        sdk.session
          .inbox({ sessionID })
          .then((result) => {
            applyResourceResponse(scopeKey, sessionID, "inbox", request, result.response?.headers, () => {
              setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" }))
            })
          })
          .catch(() => {})
      }, 120),
    )
  }

  function refreshCortex(scopeKey: string) {
    const existing = cortexRefreshTimers.get(scopeKey)
    if (existing) clearTimeout(existing)
    cortexRefreshTimers.set(
      scopeKey,
      setTimeout(() => {
        cortexRefreshTimers.delete(scopeKey)
        const state = children[scopeKey]
        if (!state) return
        const [, setStore] = state
        const sdk = createScopedClient(scopeKey)
        sdk.cortex
          .list({})
          .then((result) => setStore("cortex", reconcile(result.data ?? [])))
          .catch(() => {})
      }, 250),
    )
  }

  function reconcileCortexFromSession(store: State, setStore: SetStoreFunction<State>, info: Session) {
    const cortex = info.cortex
    if (!cortex || !terminalCortexStatuses.has(cortex.status)) return
    const idx = store.cortex.findIndex((task) => task.sessionID === info.id)
    if (idx === -1) return
    setStore(
      "cortex",
      idx,
      reconcile({
        ...store.cortex[idx],
        status: cortex.status,
        completedAt: cortex.completedAt ?? store.cortex[idx].completedAt,
        output: cortex.output ?? store.cortex[idx].output,
        error: cortex.error ?? store.cortex[idx].error,
      }),
    )
  }

  async function refreshRetainedVolatileState(scopeKey: string, store: State, setStore: SetStoreFunction<State>) {
    const sessionIDs = Array.from(
      new Set([...Object.keys(store.inbox), ...Object.keys(store.todo), ...Object.keys(store.dag)]),
    )
    const sdk = createScopedClient(scopeKey)
    await runInstanceRequests(sessionIDs, async (sessionID) => {
      const inboxRequest = captureResourceRequest(scopeKey, sessionID, "inbox")
      const todoRequest = captureResourceRequest(scopeKey, sessionID, "todo")
      const dagRequest = captureResourceRequest(scopeKey, sessionID, "dag")
      await Promise.all([
        sdk.session
          .inbox({ sessionID })
          .then((result) => {
            applyResourceResponse(scopeKey, sessionID, "inbox", inboxRequest, result.response?.headers, () => {
              setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" }))
            })
          })
          .catch(() => {}),
        sdk.session
          .todo({ sessionID })
          .then((result) => {
            applyResourceResponse(scopeKey, sessionID, "todo", todoRequest, result.response?.headers, () => {
              setStore("todo", sessionID, reconcile(result.data ?? [], { key: "id" }))
            })
          })
          .catch(() => {}),
        sdk.session
          .dag({ sessionID, ...scopeRequest(scopeKey) })
          .then((result) => {
            applyResourceResponse(scopeKey, sessionID, "dag", dagRequest, result.response?.headers, () => {
              setStore("dag", sessionID, reconcile(result.data ?? [], { key: "id" }))
            })
          })
          .catch(() => {}),
      ])
    })
  }

  async function resyncInstance(scopeKey: string) {
    if (!scopeKey || !children[scopeKey]) return
    const [store, setStore] = children[scopeKey]
    if (store.status === "loading") return
    const isHome = isHomeScope(scopeKey)
    const sdk = createScopedClient(scopeKey)

    await Promise.all([
      loadSessions(scopeKey, sdk),
      sdk.session.status().then((x) => setStore("session_status", x.data!)),
      sdk.cortex.list({}).then((x) => setStore("cortex", x.data ?? [])),
      sdk.agenda.list().then((x) =>
        setStore(
          "agenda",
          reconcile(
            (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
            { key: "id" },
          ),
        ),
      ),
      sdk.permission
        .list()
        .then((x) => syncBySession(setStore, "permission", Object.keys(store.permission), x.data ?? [])),
      sdk.question.list().then((x) => syncBySession(setStore, "question", Object.keys(store.question), x.data ?? [])),
      refreshRetainedVolatileState(scopeKey, store, setStore),
      ...(!isHome
        ? [
            sdk.mcp.status().then((x) => setStore("mcp", x.data!)),
            sdk.lsp.status().then((x) => setStore("lsp", x.data!)),
          ]
        : []),
    ])
  }

  async function bootstrapInstance(scopeKey: string) {
    if (!scopeKey) return
    const isHome = isHomeScope(scopeKey)
    const [store, setStore] = ensureScopeState(scopeKey)
    const sdk = createScopedClient(scopeKey)

    const blockingRequests: Record<string, () => Promise<void>> = {
      provider: () =>
        sdk.provider.list().then((x) => {
          const data = x.data!
          setStore("provider", {
            ...data,
            all: data.all.map((provider) => ({
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            })),
          })
        }),
      agent: () => sdk.app.agents().then((x) => setStore("agent", x.data ?? [])),
      config: () => sdk.config.get().then((x) => setStore("config", x.data!)),
    }
    blockingRequests.scopeID = isHome
      ? () => Promise.resolve(setStore("scopeID", HOME_SCOPE_KEY))
      : () => sdk.scope.current().then((x) => setStore("scopeID", x.data!.id))
    await Promise.all(Object.values(blockingRequests).map((p) => retry(p).catch((e) => setGlobalStore("error", e))))
      .then(async () => {
        if (store.status !== "complete") setStore("status", "partial")
        const requests: Promise<unknown>[] = [
          sdk.path.get(scopeRequest(scopeKey)).then((x) => setStore("path", x.data!)),
          sdk.command.list().then((x) => setStore("command", x.data ?? [])),
          sdk.session.status().then((x) => setStore("session_status", x.data!)),
          loadSessions(scopeKey, sdk),
          sdk.mcp.status().then((x) => setStore("mcp", x.data!)),
          sdk.cortex.list({}).then((x) => setStore("cortex", x.data ?? [])),
          sdk.agenda.list().then((x) =>
            setStore(
              "agenda",
              reconcile(
                (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            ),
          ),
          sdk.permission
            .list()
            .then((x) => syncBySession(setStore, "permission", Object.keys(store.permission), x.data ?? [])),
          sdk.question
            .list()
            .then((x) => syncBySession(setStore, "question", Object.keys(store.question), x.data ?? [])),
        ]
        if (!isHome) {
          requests.push(sdk.lsp.status().then((x) => setStore("lsp", x.data!)))
          requests.push(sdk.vcs.get().then((x) => setStore("vcs", x.data)))
        }
        await Promise.all(requests)
        setStore("status", "complete")
      })
      .catch((e) => setGlobalStore("error", e))
  }

  // Per-scope event watermark (highest applied state-event seq + epoch), used
  // for reconnect replay and gap detection (frontend sync redesign, phase 1).
  const watermarks = new Map<string, Watermark>()
  const replayInFlight = new Set<string>()

  // LRU eviction of loaded message/part buckets to bound memory as the user
  // switches between sessions (C7). The actively-viewed session is protected, so
  // eviction can never blank the current timeline; evicted sessions reload on
  // next view.
  const MESSAGE_BUCKET_CAP = 15
  const messageLru: string[] = []
  let activeBucketKey: string | undefined
  const bucketKey = (scopeKey: string, sessionID: string) => `${scopeKey}\n${sessionID}`

  function evictMessageBuckets() {
    const protectedIds = new Set<string>()
    if (activeBucketKey) protectedIds.add(activeBucketKey)
    const toEvict = planBucketEviction(messageLru, MESSAGE_BUCKET_CAP, protectedIds)
    if (toEvict.length === 0) return
    const evictSet = new Set(toEvict)
    for (const key of toEvict) {
      const sep = key.indexOf("\n")
      const scopeKey = key.slice(0, sep)
      const sessionID = key.slice(sep + 1)
      const state = children[scopeKey]
      if (!state) continue
      const [store, setStore] = state
      const msgs = store.message[sessionID]
      setStore(
        produce((draft) => {
          if (msgs) for (const m of msgs) delete draft.part[m.id]
          delete draft.message[sessionID]
          delete draft.messageWindow[sessionID]
        }),
      )
    }
    for (let i = messageLru.length - 1; i >= 0; i--) {
      if (evictSet.has(messageLru[i])) messageLru.splice(i, 1)
    }
  }

  function touchMessageBucket(scopeKey: string, sessionID: string) {
    const key = bucketKey(scopeKey, sessionID)
    const idx = messageLru.indexOf(key)
    if (idx !== -1) messageLru.splice(idx, 1)
    messageLru.push(key)
    evictMessageBuckets()
  }

  function markActiveSession(scopeKey: string, sessionID: string | undefined) {
    activeBucketKey = sessionID ? bucketKey(scopeKey, sessionID) : undefined
    if (scopeKey && sessionID) touchMessageBucket(scopeKey, sessionID)
  }

  function applyEvent(scopeKey: string, event: any) {
    if (event?.type === "global.disposed") {
      bootstrap()
      return
    }
    if (event?.type === "provider.auth.updated") {
      const health = event.properties.health
      setGlobalStore("provider", "authHealth", health.providerID, reconcile(health))
      for (const state of Object.values(children)) {
        state[1]("provider", "authHealth", health.providerID, reconcile(health))
      }
      return
    }
    if (event?.type === "scope.updated") {
      const result = Binary.search(globalStore.scope, event.properties.id, (s) => s.id)
      if (event.properties.time?.archived) {
        if (result.found) {
          setGlobalStore(
            "scope",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        return
      }
      if (result.found) {
        setGlobalStore("scope", result.index, reconcile(event.properties))
        return
      }
      setGlobalStore(
        "scope",
        produce((draft) => {
          draft.splice(result.index, 0, event.properties)
        }),
      )
      return
    }
    if (event?.type === "scope.removed") {
      const id = event.properties.id
      const result = Binary.search(globalStore.scope, id, (s) => s.id)
      if (result.found) {
        setGlobalStore(
          "scope",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      return
    }
    if (event?.type === "agenda.item.created" || event?.type === "agenda.item.updated") {
      const item = event.properties.item as AgendaItem
      const result = Binary.search(globalStore.agenda, item.id, (a) => a.id)
      if (result.found) {
        setGlobalStore("agenda", result.index, reconcile(item))
      } else {
        setGlobalStore(
          "agenda",
          produce((draft) => {
            draft.splice(result.index, 0, item)
          }),
        )
      }
    }
    if (event?.type === "agenda.item.deleted") {
      const result = Binary.search(globalStore.agenda, event.properties.id, (a) => a.id)
      if (result.found) {
        setGlobalStore(
          "agenda",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
    }

    if (event?.type === "config.updated") {
      const properties = event.properties as ConfigUpdatedProperties
      if (shouldRefreshGlobalConfig(properties)) {
        void loadGlobalConfig()
        return
      }
      void refreshAllConfigs()
      return
    }

    if (event?.type === "runtime.reloaded") {
      const props = event.properties as { executed?: string[]; changedFields?: string[] } | undefined
      if (props?.executed?.length) {
        void refreshTargeted(props.executed)
      } else {
        void refreshAllConfigs()
      }
      return
    }
    if (scopeKey === "global") return

    const [store, setStore] = ensureScopeState(scopeKey)
    switch (event.type) {
      case "scope.runtime.disposed": {
        scheduleBootstrap(scopeKey)
        break
      }
      case "session.updated": {
        const info = event.properties.info as Session
        reconcileCortexFromSession(store, setStore, info)
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (info.time.archived) {
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
            setStore("sessionTotal", Math.max(0, store.sessionTotal - 1))
          }
          updatePlanBlueprintOfferState(store, setStore, info.id, { type: "session_removed" })
          break
        }
        if (result.found) {
          // reconcile (not whole-object replace) so unchanged fields keep their
          // identity; a session.updated that only bumps time.updated must not
          // invalidate memos reading title/status/etc. (issue #319).
          setStore("session", result.index, reconcile(info))
          if (info.workflow?.kind !== "plan")
            updatePlanBlueprintOfferState(store, setStore, info.id, { type: "plan_exited" })
          else refreshPlanBlueprintOfferFromLoadedParts(store, setStore, info.id)
          break
        }
        setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 0, info)
          }),
        )
        setStore("sessionTotal", store.sessionTotal + 1)
        if (info.workflow?.kind === "plan") refreshPlanBlueprintOfferFromLoadedParts(store, setStore, info.id)
        break
      }
      case "session.diff":
        setStore("session_diff", event.properties.sessionID, reconcile(event.properties.diff, { key: "file" }))
        break
      case "todo.updated":
        applyResourceEvent(scopeKey, event.properties.sessionID, "todo", event, () => {
          setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        })
        break
      case "dag.updated" as string: {
        const properties = (event as any).properties
        applyResourceEvent(scopeKey, properties.sessionID, "dag", event, () => {
          setStore("dag", properties.sessionID, reconcile(properties.nodes, { key: "id" }))
        })
        break
      }
      case "session.status": {
        // Handles busy, retry, idle, and recovering statuses
        setStore("session_status", event.properties.sessionID, reconcile(event.properties.status))
        if (event.properties.status.type === "idle") {
          if (store.inbox[event.properties.sessionID]?.length) refreshInbox(scopeKey, event.properties.sessionID)
          if (
            store.cortex.some(
              (task) =>
                task.sessionID === event.properties.sessionID &&
                (task.status === "running" || task.status === "queued"),
            )
          ) {
            refreshCortex(scopeKey)
          }
        }
        break
      }
      case "session.inbox.updated": {
        applyResourceEvent(scopeKey, event.properties.sessionID, "inbox", event, () => {
          setStore("inbox", event.properties.sessionID, reconcile(event.properties.items, { key: "id" }))
        })
        break
      }
      case "mcp.ready":
      case "mcp.failed":
      case "mcp.tools.changed":
      case "mcp.prompts.changed":
      case "mcp.resources.changed": {
        void createScopedClient(scopeKey)
          .mcp.status()
          .then((x) => setStore("mcp", x.data!))
        break
      }
      case "message.updated": {
        const info = event.properties.info as Message
        const sessionID = info.sessionID
        applyResourceEvent(scopeKey, sessionID, "message", event, () => {
          touchMessageBucket(scopeKey, sessionID)
          const messages = store.message[sessionID] ?? []
          const metadata = store.messageWindow[sessionID]
          const existing = messages.some((message) => message.id === info.id)
          const current: MessageWindowState<Message> = {
            messages,
            mode: metadata?.mode ?? "latest",
            pendingLatest: metadata?.pendingLatest ?? false,
            pendingLatestIds: metadata?.pendingLatestIds ?? [],
          }
          const result = reconcileMessage(current, info)

          batch(() => {
            setStore(
              produce((draft) => {
                for (const messageID of result.droppedIds) delete draft.part[messageID]
              }),
            )
            setStore("message", sessionID, reconcile(result.window.messages, { key: "id" }))
            if (metadata) {
              setStore(
                "messageWindow",
                sessionID,
                reconcile({
                  ...metadata,
                  total: nextMessageWindowTotal({
                    total: metadata.total,
                    existing,
                    visible: result.window.messages.some((message) => message.id === info.id),
                  }),
                  mode: result.window.mode,
                  pendingLatest: result.window.pendingLatest,
                  pendingLatestIds: result.window.pendingLatestIds,
                }),
              )
            }
          })
        })
        break
      }
      case "message.removed": {
        const sessionID = event.properties.sessionID as string
        const messageID = event.properties.messageID as string
        applyResourceEvent(scopeKey, sessionID, "message", event, () => {
          const messages = store.message[sessionID]
          if (!messages) return
          const metadata = store.messageWindow[sessionID]
          const current: MessageWindowState<Message> = {
            messages,
            mode: metadata?.mode ?? "latest",
            pendingLatest: metadata?.pendingLatest ?? false,
            pendingLatestIds: metadata?.pendingLatestIds ?? [],
          }
          const pending = current.pendingLatestIds.includes(messageID)
          const result = removeMessageFromWindow(current, messageID)
          const removedVisible = result.messages.length !== messages.length
          batch(() => {
            if (removedVisible) {
              setStore(
                produce((draft) => {
                  delete draft.part[messageID]
                }),
              )
              setStore("message", sessionID, reconcile(result.messages, { key: "id" }))
            }
            if (metadata) {
              setStore(
                "messageWindow",
                sessionID,
                reconcile({
                  ...metadata,
                  total: nextMessageWindowTotalAfterRemoval({ total: metadata.total, pending }),
                  pendingLatest: result.pendingLatest,
                  pendingLatestIds: result.pendingLatestIds,
                }),
              )
            }
          })
        })
        break
      }
      case "message.part.delta": {
        // Compact streaming frame (#350 D1): append the increment to an existing
        // text/reasoning part with a fine-grained store write, touching only the
        // .text leaf. If the part container or the part itself is not present yet
        // (frame arrived before the first checkpoint), ignore it — a full
        // `message.part.updated` checkpoint follows within EventWire.CHECKPOINT_MS
        // and reconciles authoritative state.
        const { messageID, partID, delta } = event.properties as {
          messageID: string
          partID: string
          delta: string
        }
        const parts = store.part[messageID]
        if (!parts) break
        const result = Binary.search(parts, partID, (p) => p.id)
        if (!result.found) break
        // Fine-grained: produce mutates only the .text leaf of this one part, so
        // a streaming reply re-renders the changed text node rather than the
        // whole part on every delta.
        setStore(
          "part",
          messageID,
          result.index,
          produce((p: any) => {
            if (typeof p?.text === "string") p.text += delta
          }),
        )
        recordTokenApply({
          id: partID,
          sessionID: event.properties.sessionID,
          messageID,
          type: event.properties.kind,
        })
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        invalidateResource(scopeKey, part.sessionID, "message")
        if (!store.message[part.sessionID]?.some((message) => message.id === part.messageID)) break
        const parts = store.part[part.messageID]
        if (!parts) {
          if (part.type === "tool") {
            console.debug("[sync] tool.part.apply", {
              action: describeToolPartApply({ hasBucket: false, found: false }),
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              callID: (part as any).callID,
              tool: (part as any).tool,
              status: (part as any).state?.status,
            })
          }
          setStore("part", part.messageID, [part])
        } else {
          const result = Binary.search(parts, part.id, (p) => p.id)
          if (part.type === "tool") {
            console.debug("[sync] tool.part.apply", {
              action: describeToolPartApply({ hasBucket: true, found: result.found }),
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              callID: (part as any).callID,
              tool: (part as any).tool,
              status: (part as any).state?.status,
            })
          }
          if (result.found) {
            // reconcile so a streaming text/tool part only touches changed
            // leaves instead of re-rendering the whole part on every delta.
            setStore("part", part.messageID, result.index, reconcile(part))
          } else {
            setStore(
              "part",
              part.messageID,
              produce((draft) => {
                draft.splice(result.index, 0, part)
              }),
            )
          }
        }

        capturePlanBlueprintOfferFromPart(store, setStore, part)
        if (event.properties.delta !== undefined) recordTokenApply(part)

        // Optimistic workspace update for worktree tools — the status bar reads
        // session.workspace from the store and should reflect the new workspace
        // immediately when the tool result appears, without waiting for the
        // session.updated event. This races with the canonical session.updated
        // handler; in practice the events carry identical data so the race is benign.
        const transition = resolveWorkspaceTransition(part)
        if (transition.kind !== "none") {
          const idx = Binary.search(store.session, part.sessionID, (s) => s.id)
          if (idx.found) {
            if (transition.kind === "enter") {
              setStore("session", idx.index, "workspace", transition.workspace)
            } else {
              const workspace: SessionWorkspace = {
                ...transition.workspace,
                scopeID: store.session[idx.index].scope.id,
              }
              setStore("session", idx.index, "workspace", workspace)
            }
          }
        }
        break
      }
      case "message.part.removed": {
        invalidateResource(scopeKey, event.properties.sessionID, "message")
        const parts = store.part[event.properties.messageID]
        if (!parts) break
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (result.found) {
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "vcs.branch.updated": {
        setStore("vcs", { branch: event.properties.branch })
        break
      }
      case "permission.asked": {
        const sessionID = event.properties.sessionID
        const permissions = store.permission[sessionID]
        if (!permissions) {
          setStore("permission", sessionID, [event.properties])
          break
        }

        const result = Binary.search(permissions, event.properties.id, (p) => p.id)
        if (result.found) {
          setStore("permission", sessionID, result.index, reconcile(event.properties))
          break
        }

        setStore(
          "permission",
          sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties)
          }),
        )
        break
      }
      case "permission.replied": {
        const permissions = store.permission[event.properties.sessionID]
        if (!permissions) break
        const result = Binary.search(permissions, event.properties.requestID, (p) => p.id)
        if (!result.found) break
        setStore(
          "permission",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "question.asked": {
        const request = event.properties
        const requests = store.question[request.sessionID]
        if (!requests) {
          setStore("question", request.sessionID, [request])
          break
        }
        const result = Binary.search(requests, request.id, (r) => r.id)
        if (result.found) {
          setStore("question", request.sessionID, result.index, reconcile(request))
          break
        }
        setStore(
          "question",
          request.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, request)
          }),
        )
        break
      }
      case "question.replied":
      case "question.rejected":
      case "question.timed_out": {
        const requests = store.question[event.properties.sessionID]
        if (!requests) break
        const result = Binary.search(requests, event.properties.requestID, (r) => r.id)
        if (!result.found) break
        setStore(
          "question",
          event.properties.sessionID,
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        break
      }
      case "lsp.updated": {
        const sdk = createScopedClient(scopeKey)
        sdk.lsp.status().then((x) => setStore("lsp", x.data ?? []))
        break
      }
      case "cortex.task.created": {
        const task = event.properties.task
        setStore(
          "cortex",
          produce((draft) => {
            const idx = draft.findIndex((t) => t.id === task.id)
            if (idx === -1) {
              draft.push(task)
            } else {
              draft[idx] = task
            }
          }),
        )
        break
      }
      case "cortex.task.completed": {
        const task = event.properties.task
        setStore(
          "cortex",
          produce((draft) => {
            const idx = draft.findIndex((t) => t.id === task.id)
            if (idx !== -1) {
              draft[idx] = task
            }
          }),
        )
        break
      }
      case "cortex.tasks.updated": {
        setStore("cortex", reconcile(event.properties.tasks))
        break
      }
      case "agenda.item.created":
      case "agenda.item.updated": {
        const item = event.properties.item
        const result = Binary.search(store.agenda, item.id, (a) => a.id)
        if (result.found) {
          setStore("agenda", result.index, reconcile(item))
          break
        }
        setStore(
          "agenda",
          produce((draft) => {
            draft.splice(result.index, 0, item)
          }),
        )
        break
      }
      case "agenda.item.deleted": {
        const result = Binary.search(store.agenda, event.properties.id, (a) => a.id)
        if (result.found) {
          setStore(
            "agenda",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "session.compacted": {
        const sessionID = event.properties.sessionID as string
        const currentMessages = store.message[sessionID]
        if (!currentMessages) break
        const version = parseSyncVersion(event)
        const acceptedInbox = resourceFreshness.acceptEvent({ scopeKey, sessionID, resource: "inbox" }, version)
        const acceptedMessages = resourceFreshness.acceptEvent({ scopeKey, sessionID, resource: "message" }, version)
        if (!acceptedInbox || !acceptedMessages) break
        const inboxRequest = captureResourceRequest(scopeKey, sessionID, "inbox")
        const messageRequest = captureResourceRequest(scopeKey, sessionID, "message")
        const sdk = createScopedClient(scopeKey)
        retry(() => sdk.session.messagePage({ sessionID, limit: 200 }))
          .then((result) => {
            if (!result.data) return
            applyResourceResponse(scopeKey, sessionID, "message", messageRequest, result.response?.headers, () => {
              const metadata = store.messageWindow[sessionID]
              const plan = planMessagePageApply({
                page: result.data!,
                current: {
                  messages: currentMessages,
                  mode: metadata?.mode ?? "latest",
                  pendingLatest: metadata?.pendingLatest ?? false,
                  pendingLatestIds: metadata?.pendingLatestIds ?? [],
                },
              })
              batch(() => {
                setStore(
                  produce((draft) => {
                    for (const messageID of plan.droppedIds) delete draft.part[messageID]
                    delete draft.session_diff[sessionID]
                    if (isResourceRequestCurrent(scopeKey, sessionID, "inbox", inboxRequest)) {
                      delete draft.inbox[sessionID]
                    }
                  }),
                )
                setStore("message", sessionID, reconcile(plan.window.messages, { key: "id" }))
                setStore("messageWindow", sessionID, reconcile(plan.metadata))
                for (const [messageID, parts] of Object.entries(plan.parts)) {
                  setStore("part", messageID, reconcile(parts, { key: "id" }))
                }
              })
            })
          })
          .catch(() => {})
        break
      }
    }
  }

  const unsub = globalSDK.event.listen((e) => {
    // Retired-epoch events must not affect either the store or watermark.
    // Streaming events carry no seq and pass through without changing either
    // freshness or watermark state. seq/epoch are additive envelope fields not
    // present in the generated Event type, so read them structurally.
    const sequencedDetails = e.details as unknown as { epoch?: unknown; seq?: unknown }
    const version =
      typeof sequencedDetails.epoch === "string" && typeof sequencedDetails.seq === "number"
        ? parseSyncVersion(sequencedDetails)
        : undefined
    if (!resourceFreshness.acceptScopeEvent(e.name, version)) return
    const observed = observeWatermark(watermarks.get(e.name), sequencedDetails as { epoch?: string; seq?: number })
    if (observed.next) watermarks.set(e.name, observed.next)
    if (observed.epochChanged || observed.gap) void replayOrResync(e.name)
    applyEvent(e.name, e.details)
  })
  onCleanup(() => {
    unsub()
    for (const timer of inboxRefreshTimers.values()) clearTimeout(timer)
    for (const timer of cortexRefreshTimers.values()) clearTimeout(timer)
    inboxRefreshTimers.clear()
    cortexRefreshTimers.clear()
  })

  // Reconnect recovery: try to replay only the events missed since our
  // watermark instead of refetching everything. Falls back to a full resync on
  // reset (stale epoch / pruned journal) or any error — so it can never lose
  // updates, only do more work.
  async function replayOrResync(scopeKey: string) {
    if (scopeKey === "global" || !children[scopeKey]) return
    if (replayInFlight.has(scopeKey)) return
    const wm = watermarks.get(scopeKey)
    if (!wm) {
      await resyncInstance(scopeKey).catch(() => undefined)
      return
    }
    replayInFlight.add(scopeKey)
    try {
      const sdk = createScopedClient(scopeKey)
      const res = await sdk.event.replay({ since: wm.seq, epoch: wm.epoch })
      const data = res.data as
        | { status: "ok"; epoch: string; seq: number; events: any[] }
        | { status: "reset"; epoch: string; seq: number }
        | undefined
      if (!data || data.status === "reset") {
        watermarks.delete(scopeKey)
        if (data) resourceFreshness.resetScope(scopeKey, data.epoch, data.seq)
        await resyncInstance(scopeKey).catch(() => undefined)
        return
      }
      for (const ev of data.events) applyEvent(scopeKey, ev)
      watermarks.set(scopeKey, { epoch: data.epoch, seq: data.seq })
    } catch {
      await resyncInstance(scopeKey).catch(() => undefined)
    } finally {
      replayInFlight.delete(scopeKey)
    }
  }

  let resyncInstancesPromise: Promise<void> | undefined
  function resyncInstances(directories: string[]) {
    if (resyncInstancesPromise) return resyncInstancesPromise
    // Signal reconnect so store-external resources (blueprint loops) refetch.
    setReconnectVersion((v) => v + 1)
    resyncInstancesPromise = runInstanceRequests(directories, (directory) =>
      replayOrResync(directory).catch(() => undefined),
    ).finally(() => {
      resyncInstancesPromise = undefined
    })
    return resyncInstancesPromise
  }

  createEffect(() => {
    const isConnected = globalSDK.connected()

    if (isConnected && globalStore.ready) {
      void resyncInstances(Object.keys(children))
      void loadGlobalAgenda()
    }
  })

  async function bootstrap() {
    const health = await globalSDK.client.global
      .health()
      .then((x) => x.data)
      .catch(() => undefined)
    if (!health?.healthy) {
      setGlobalStore(
        "error",
        new Error(`Could not connect to server. Is there a server running at \`${globalSDK.url}\`?`),
      )
      return
    }

    return Promise.all([
      retry(loadGlobalConfig),
      retry(() =>
        globalSDK.client.global.paths.get().then((x) => {
          setGlobalStore("paths", x.data!)
        }),
      ),
      retry(() =>
        globalSDK.client.scope.list().then(async (x) => {
          const scopes = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("synergy-test"))
            .filter((p) => !p.time?.archived)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
          setGlobalStore("scope", scopes)
        }),
      ),
      retry(() =>
        globalSDK.client.provider.list().then((x) => {
          const data = x.data!
          setGlobalStore("provider", {
            ...data,
            all: data.all.map((provider) => ({
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            })),
          })
        }),
      ),
      retry(() =>
        globalSDK.client.provider.auth().then((x) => {
          setGlobalStore("provider_auth", x.data ?? {})
        }),
      ),
    ])
      .then(() => {
        setGlobalStore("ready", true)
        loadGlobalAgenda()
      })
      .catch((e) => setGlobalStore("error", e))
  }

  onMount(() => {
    bootstrap()
  })

  return {
    data: globalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    peekScopeState,
    ensureScopeState,
    releaseScopeState,
    markActiveSession,
    touchMessageBucket,
    bootstrap,
    reconnectVersion,
    captureResourceRequest,
    applyResourceResponse,
    invalidateResource,
    get agenda() {
      return globalStore.agenda
    },
    loadGlobalAgenda,
    refreshConfig,
    refreshAllConfigs,
    refreshProviders: () => refreshTargeted(["provider"]),
    scope: {
      loadSessions,
      loadAgenda,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  const { _ } = useLingui()
  return (
    <Switch
      fallback={
        <div class="synergy-workbench-canvas size-full flex items-center justify-center bg-background-stronger text-text-weak">
          {_(AP.appLoading)}
        </div>
      }
    >
      <Match when={value.error}>
        <ErrorPage error={value.error} />
      </Match>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>
          <LocaleConfigReconciler preference={() => value.data.config.locale} />
          {props.children}
        </GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
