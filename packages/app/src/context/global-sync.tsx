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
import type { SessionWorkspace } from "@ericsanchezok/synergy-sdk/client"
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { useGlobalSDK } from "./global-sdk"
import { ErrorPage, type InitError } from "../pages/error"
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
  part: {
    [messageID: string]: Part[]
  }
}

export interface NoteUpdateSignal {
  id: string
  version: number
  type: "created" | "updated" | "deleted"
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    paths: GlobalPaths
    scope: Scope[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
    agenda: AgendaItem[]
  }>({
    ready: false,
    paths: { home: "", root: "", data: "", config: "", state: "", cache: "", log: "" },
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
  const [noteVersion, setNoteVersion] = createSignal(0)
  const [noteUpdate, setNoteUpdate] = createSignal<NoteUpdateSignal | null>(null, { equals: false })
  function bumpNoteVersion() {
    setNoteVersion((v) => v + 1)
  }

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
        inbox: {},
        mcp: {},
        lsp: [],
        cortex: [],
        agenda: [],
        vcs: undefined,
        sessionTotal: 0,
        message: {},
        part: {},
      })
      scheduleBootstrap(scopeKey)
    }
    return children[scopeKey]
  }

  function releaseScopeState(scopeKey: string) {
    delete children[scopeKey]
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
        sdk.session
          .inbox({ sessionID })
          .then((result) => setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" })))
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

  function reconcileCortexFromSession(setStore: SetStoreFunction<State>, info: Session) {
    const cortex = info.cortex
    if (!cortex || !terminalCortexStatuses.has(cortex.status)) return
    setStore(
      "cortex",
      produce((draft) => {
        const idx = draft.findIndex((task) => task.sessionID === info.id)
        if (idx === -1) return
        draft[idx] = {
          ...draft[idx],
          status: cortex.status,
          completedAt: cortex.completedAt ?? draft[idx].completedAt,
          result: cortex.result ?? draft[idx].result,
          error: cortex.error ?? draft[idx].error,
        }
      }),
    )
  }

  function refreshVolatileStateAfterMessage(scopeKey: string, store: State, sessionID: string) {
    if (store.inbox[sessionID]?.length) refreshInbox(scopeKey, sessionID)
    if (
      store.cortex.some(
        (task) => task.sessionID === sessionID && (task.status === "running" || task.status === "queued"),
      )
    ) {
      refreshCortex(scopeKey)
    }
  }

  async function refreshRetainedVolatileState(scopeKey: string, store: State, setStore: SetStoreFunction<State>) {
    const sessionIDs = Array.from(
      new Set([...Object.keys(store.inbox), ...Object.keys(store.todo), ...Object.keys(store.dag)]),
    )
    const sdk = createScopedClient(scopeKey)
    await runInstanceRequests(sessionIDs, async (sessionID) => {
      await Promise.all([
        sdk.session
          .inbox({ sessionID })
          .then((result) => setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" })))
          .catch(() => {}),
        sdk.session
          .todo({ sessionID })
          .then((result) => setStore("todo", sessionID, reconcile(result.data ?? [], { key: "id" })))
          .catch(() => {}),
        sdk.session
          .dag({ sessionID, ...scopeRequest(scopeKey) })
          .then((result) => setStore("dag", sessionID, reconcile(result.data ?? [], { key: "id" })))
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

  const unsub = globalSDK.event.listen((e) => {
    const scopeKey = e.name
    const event = e.details

    if (event?.type === "global.disposed") {
      bootstrap()
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
    if (event?.type === "note.created" || event?.type === "note.updated" || event?.type === "note.deleted") {
      bumpNoteVersion()
      if (event.type === "note.deleted") {
        const props = event.properties as { id: string; scopeID: string }
        setNoteUpdate({ id: props.id, version: -1, type: "deleted" })
      } else {
        const props = event.properties as { note: { id: string; version: number } }
        setNoteUpdate({
          id: props.note.id,
          version: props.note.version,
          type: event.type as "created" | "updated",
        })
      }
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
    if (e.name === "global") return

    const [store, setStore] = ensureScopeState(scopeKey)
    switch (event.type) {
      case "scope.runtime.disposed": {
        scheduleBootstrap(scopeKey)
        break
      }
      case "session.updated": {
        const info = event.properties.info as Session
        reconcileCortexFromSession(setStore, info)
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
          break
        }
        if (result.found) {
          setStore(
            "session",
            produce((draft) => {
              draft[result.index] = info
            }),
          )
          break
        }
        setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 0, info)
          }),
        )
        setStore("sessionTotal", store.sessionTotal + 1)
        break
      }
      case "session.diff":
        setStore("session_diff", event.properties.sessionID, reconcile(event.properties.diff, { key: "file" }))
        break
      case "todo.updated":
        setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        break
      case "dag.updated" as string:
        setStore("dag", (event as any).properties.sessionID, reconcile((event as any).properties.nodes, { key: "id" }))
        break
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
        setStore("inbox", event.properties.sessionID, reconcile(event.properties.items, { key: "id" }))
        break
      }
      case "message.updated": {
        const sessionID = event.properties.info.sessionID
        const messages = store.message[event.properties.info.sessionID]
        if (!messages) {
          setStore("message", event.properties.info.sessionID, [event.properties.info])
          refreshVolatileStateAfterMessage(scopeKey, store, sessionID)
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          refreshVolatileStateAfterMessage(scopeKey, store, sessionID)
          break
        }
        setStore(
          "message",
          event.properties.info.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }),
        )
        refreshVolatileStateAfterMessage(scopeKey, store, sessionID)
        break
      }
      case "message.removed": {
        const messages = store.message[event.properties.sessionID]
        if (!messages) break
        const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
        if (result.found) {
          setStore(
            "message",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        const parts = store.part[part.messageID]
        if (!parts) {
          setStore("part", part.messageID, [part])
        } else {
          const result = Binary.search(parts, part.id, (p) => p.id)
          if (result.found) {
            setStore("part", part.messageID, result.index, part)
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
        const messages = store.message[sessionID]
        if (!messages) break
        batch(() => {
          setStore(
            produce((draft) => {
              for (const msg of messages) {
                delete draft.part[msg.id]
              }
              delete draft.message[sessionID]
              delete draft.session_diff[sessionID]
              delete draft.inbox[sessionID]
            }),
          )
        })
        const sdk = createScopedClient(scopeKey)
        retry(() => sdk.session.messages({ sessionID, limit: 200 }))
          .then((result) => {
            const items = (result.data ?? []).filter((x) => !!x?.info?.id)
            const all = items
              .map((x) => x.info)
              .filter((m) => !!m?.id)
              .slice()
              .sort((a, b) => a.id.localeCompare(b.id))
            const keep = all.length > 500 ? all.slice(-500) : all
            batch(() => {
              setStore("message", sessionID, reconcile(keep, { key: "id" }))
              const keepIds = new Set(keep.map((m) => m.id))
              for (const item of items) {
                if (!keepIds.has(item.info.id)) continue
                setStore(
                  "part",
                  item.info.id,
                  reconcile(
                    item.parts
                      .filter((p) => !!p?.id)
                      .slice()
                      .sort((a, b) => a.id.localeCompare(b.id)),
                    { key: "id" },
                  ),
                )
              }
            })
          })
          .catch(() => {})
        break
      }
    }
  })
  onCleanup(() => {
    unsub()
    for (const timer of inboxRefreshTimers.values()) clearTimeout(timer)
    for (const timer of cortexRefreshTimers.values()) clearTimeout(timer)
    inboxRefreshTimers.clear()
    cortexRefreshTimers.clear()
  })

  let resyncInstancesPromise: Promise<void> | undefined
  function resyncInstances(directories: string[]) {
    if (resyncInstancesPromise) return resyncInstancesPromise
    resyncInstancesPromise = runInstanceRequests(directories, (directory) =>
      resyncInstance(directory).catch(() => undefined),
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
    bootstrap,
    noteVersion,
    noteUpdate,
    get agenda() {
      return globalStore.agenda
    },
    loadGlobalAgenda,
    refreshConfig,
    refreshAllConfigs,
    scope: {
      loadSessions,
      loadAgenda,
    },
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return (
    <Switch fallback={<div class="size-full flex items-center justify-center text-text-weak">Loading...</div>}>
      <Match when={value.error}>
        <ErrorPage error={value.error} />
      </Match>
      <Match when={value.ready}>
        <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
      </Match>
    </Switch>
  )
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
