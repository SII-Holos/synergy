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

      for (const [sessionID, group] of Object.entries(grouped)) {
        group.sort((a, b) => a.id!.localeCompare(b.id!))
        setStore(storeKey, sessionID, reconcile(group, { key: "id" }))
      }
    })
  }

  let inboxRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function refreshInbox(scopeKey: string, sessionID: string) {
    const existing = inboxRefreshTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    inboxRefreshTimers.set(
      sessionID,
      setTimeout(() => {
        inboxRefreshTimers.delete(sessionID)
        const sdk = createScopedClient(scopeKey)
        sdk.session
          .inbox({ sessionID })
          .then((x) => {
            const items = x.data ?? []
            const [_, setStore] = ensureScopeState(scopeKey)
            setStore("inbox", sessionID, reconcile(items, { key: "id" }))
          })
          .catch(() => {})
      }, 500),
    )
  }

  let cortexRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function refreshCortex(scopeKey: string) {
    const existing = cortexRefreshTimers.get(scopeKey)
    if (existing) clearTimeout(existing)
    cortexRefreshTimers.set(
      scopeKey,
      setTimeout(() => {
        cortexRefreshTimers.delete(scopeKey)
        const sdk = createScopedClient(scopeKey)
        sdk.cortex
          .list()
          .then((x) => {
            const [_, setStore] = ensureScopeState(scopeKey)
            setStore(
              "cortex",
              reconcile(
                (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            )
          })
          .catch(() => {})
      }, 500),
    )
  }

  function refreshVolatileStateAfterMessage(scopeKey: string, store: State, sessionID: string) {
    if (!store.session.find((s) => s.id === sessionID)) return
    const active =
      store.cortex.filter(
        (task) => task.sessionID === sessionID && (task.status === "running" || task.status === "queued"),
      ).length > 0
    if (active) refreshCortex(scopeKey)
    refreshInbox(scopeKey, sessionID)
  }

  async function loadMessages(
    scopeKey: string,
    sessionID: string,
    setStore: SetStoreFunction<State>,
    store: State,
    sdk?: ReturnType<typeof createSynergyClient>,
  ) {
    const client = sdk ?? createScopedClient(scopeKey)
    return client.session
      .messages({ sessionID, limit: 200 })
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
      .catch((err) => {
        console.error("Failed to load messages", err)
      })
  }

  async function resyncInstance(directory: string) {
    const [store, setStore] = ensureScopeState(directory)
    const sdk = createScopedClient(directory)

    return retry(() =>
      sdk.scope.sync().then(async (sync) => {
        const d = sync.data!
        batch(() => {
          setStore("scopeID", d.scopeID!)
          setStore("status", "partial")
          setStore("path", {
            state: d.paths?.state ?? "",
            config: d.paths?.config ?? "",
            worktree: d.paths?.worktree ?? "",
            directory: d.paths?.directory ?? "",
            home: d.paths?.home ?? "",
          })
          setStore("agent", reconcile(d.agents ?? [], { key: "id" }))
          setStore("command", reconcile(d.commands ?? [], { key: "id" }))
          setStore("session", reconcile(d.sessions ?? [], { key: "id" }))
          setStore("sessionTotal", d.sessionTotal ?? 0)

          const statusMap: Record<string, SessionStatus> = {}
          for (const status of d.sessionStatuses ?? []) {
            if (!status.sessionID) continue
            statusMap[status.sessionID] = status
          }
          setStore("session_status", statusMap)

          const diffMap: Record<string, FileDiff[]> = {}
          for (const diff of d.sessionDiffs ?? []) {
            if (!diff.sessionID) continue
            diffMap[diff.sessionID] = diff.diffs ?? []
          }
          setStore("session_diff", diffMap)

          syncBySession(setStore, "permission", Object.keys(store.permission), d.permissions ?? [])
          syncBySession(setStore, "question", Object.keys(store.question), d.questions ?? [])
        })

        const loadPromises: Promise<unknown>[] = [
          loadSessions(directory, sdk),
          loadAgenda(directory),
          refreshConfig(directory),
          loadGlobalProviders(),
        ]

        const sessionIDs = new Set<string>()
        for (const s of d.sessions ?? []) {
          if (!s?.id || !s.time || s.time.archived) continue
          sessionIDs.add(s.id)
        }

        loadPromises.push(
          runInstanceRequests([...sessionIDs], (sessionID) => {
            const [store, setStore] = ensureScopeState(directory)
            const client = createScopedClient(directory)
            return loadMessages(directory, sessionID, setStore, store, client)
          }),
        )

        await Promise.all(loadPromises)

        sdk.mcp
          .status()
          .then((x) => setStore("mcp", x.data!))
          .catch(() => {})
        sdk.lsp
          .status()
          .then((x) => setStore("lsp", x.data!))
          .catch(() => {})
        sdk.cortex
          .list()
          .then((x) => {
            setStore(
              "cortex",
              reconcile(
                (x.data ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            )
          })
          .catch(() => {})
        sdk.vcs
          .status()
          .then((x) => {
            if (x.data) setStore("vcs", x.data)
          })
          .catch(() => {})
        setStore("status", "complete")
      }),
    )
  }

  async function loadMessagesForNewSession(scopeKey: string, sessionID: string) {
    const [store, setStore] = ensureScopeState(scopeKey)
    const client = createScopedClient(scopeKey)
    return loadMessages(scopeKey, sessionID, setStore, store, client)
  }

  async function bootstrapInstance(scopeKey: string) {
    return resyncInstance(scopeKey).then(() => {
      const [store, setStore] = ensureScopeState(scopeKey)
      const sdk = createScopedClient(scopeKey)
      const unsub = sdk.subscribe((event) => {
        switch (event.type) {
          case "session.created": {
            const session = event.properties.session
            const result = Binary.search(store.session, session.id, (s) => s.id)
            if (result.found) {
              setStore("session", result.index, reconcile(session))
            } else {
              setStore(
                "session",
                produce((draft) => {
                  draft.splice(result.index, 0, session)
                }),
              )
            }
            setStore("sessionTotal", (x) => x + 1)
            loadMessagesForNewSession(scopeKey, session.id)
            break
          }
          case "session.updated": {
            const session = event.properties.session
            const result = Binary.search(store.session, session.id, (s) => s.id)
            if (result.found) {
              setStore("session", result.index, reconcile(session))
            } else {
              setStore(
                "session",
                produce((draft) => {
                  draft.splice(result.index, 0, session)
                }),
              )
            }
            break
          }
          case "session.removed": {
            const result = Binary.search(store.session, event.properties.sessionID, (s) => s.id)
            if (!result.found) break
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
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
          case "todo.updated": {
            if (!event.properties.sessionID || !event.properties.todos) break
            setStore("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
            break
          }
          case "dag.updated": {
            if (!event.properties.sessionID || !event.properties.dag) break
            setStore("dag", event.properties.sessionID, event.properties.dag)
            break
          }
          case "todo.created":
          case "todo.updated.event": {
            const todo = event.properties.todo
            const todos = store.todo[todo.sessionID]
            if (!todos) {
              setStore("todo", todo.sessionID, [todo])
              break
            }
            const result = Binary.search(todos, todo.id, (t) => t.id)
            if (result.found) {
              setStore("todo", todo.sessionID, result.index, reconcile(todo))
              break
            }
            setStore(
              "todo",
              todo.sessionID,
              produce((draft) => {
                draft.splice(result.index, 0, todo)
              }),
            )
            break
          }
          case "todo.deleted": {
            const todos = store.todo[event.properties.sessionID]
            if (!todos) break
            const result = Binary.search(todos, event.properties.todoID, (t) => t.id)
            if (!result.found) break
            setStore(
              "todo",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
            break
          }
          case "session.diff.updated": {
            const diffs = event.properties.diffs
            if (!diffs) break
            setStore("session_diff", event.properties.sessionID, reconcile(diffs, { key: "path" }))
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

            // Optimistic workspace update for worktree tools — the status bar reads
            // session.workspace from the store and should reflect the new workspace
            // immediately when the tool result appears, without waiting for the
            // session.updated event. This races with the canonical session.updated
            // handler; in practice the events carry identical data so the race is benign.
            if (part.type === "tool" && part.state.status === "completed") {
              if (part.tool === "worktree_enter" && part.state.metadata?.action === "entered") {
                const ws = part.state.metadata?.workspace as Record<string, unknown> | undefined
                if (ws) {
                  const idx = Binary.search(store.session, part.sessionID, (s) => s.id)
                  if (idx.found) setStore("session", idx.index, "workspace", ws)
                }
              } else if (part.tool === "worktree_leave" && part.state.metadata?.action === "left") {
                const restored = part.state.metadata?.restored as { type?: string; path?: string } | undefined
                if (restored) {
                  const idx = Binary.search(store.session, part.sessionID, (s) => s.id)
                  if (idx.found) {
                    setStore("session", idx.index, "workspace", {
                      type: restored.type ?? "main",
                      path: restored.path,
                      scopeID: (store.session[idx.index] as { scope?: { id?: string } })?.scope?.id ?? "",
                    })
                  }
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
        }
      })
      onCleanup(() => {
        unsub()
        for (const timer of inboxRefreshTimers.values()) clearTimeout(timer)
        for (const timer of cortexRefreshTimers.values()) clearTimeout(timer)
        inboxRefreshTimers.clear()
        cortexRefreshTimers.clear()
      })
    })
  }

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
