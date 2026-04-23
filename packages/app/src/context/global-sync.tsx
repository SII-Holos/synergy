import {
  type Message,
  type Agent,
  type Session,
  type Part,
  type Config,
  type Path,
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
  createSynergyClient,
} from "@ericsanchezok/synergy-sdk/client"
import { createStore, produce, reconcile } from "solid-js/store"
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
import { isGlobalScope } from "@/utils/scope"
import type { ConfigSetSummary } from "@ericsanchezok/synergy-sdk/client"

type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  scopeID: string
  provider: ProviderListResponse
  config: Config
  path: Path
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

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const [globalStore, setGlobalStore] = createStore<{
    ready: boolean
    error?: InitError
    path: Path
    scope: Scope[]
    provider: ProviderListResponse
    provider_auth: ProviderAuthResponse
    agenda: AgendaItem[]
    config_sets: ConfigSetSummary[]
  }>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    scope: [],
    provider: { all: [], connected: [], default: {}, configProviders: [] },
    provider_auth: {},
    agenda: [],
    config_sets: [],
  })

  const children: Record<string, ReturnType<typeof createStore<State>>> = {}
  const [noteVersion, setNoteVersion] = createSignal(0)
  function bumpNoteVersion() {
    setNoteVersion((v) => v + 1)
  }
  function child(directory: string) {
    if (!directory) console.error("No directory provided")
    if (!children[directory]) {
      children[directory] = createStore<State>({
        scopeID: "",
        provider: { all: [], connected: [], default: {}, configProviders: [] },
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
        mcp: {},
        lsp: [],
        cortex: [],
        agenda: [],
        vcs: undefined,
        sessionTotal: 0,
        message: {},
        part: {},
      })
      bootstrapInstance(directory)
    }
    return children[directory]
  }

  function releaseChild(directory: string) {
    // The global event listener calls child() which may recreate the store
    // if a late event arrives for this directory. The recreated store stays
    // empty (no bootstrapInstance) and will be collected on the next release.
    delete children[directory]
  }

  async function loadAgenda(directory: string) {
    const [_, setStore] = child(directory)
    const sdk = createSynergyClient({ baseUrl: globalSDK.url, directory, throwOnError: true })
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

  async function loadConfigSets() {
    return globalSDK.client.config.set
      .list()
      .then((x) => {
        setGlobalStore("config_sets", reconcile(x.data ?? [], { key: "name" }))
      })
      .catch((err) => {
        console.error("Failed to load config sets", err)
      })
  }

  async function refreshConfig(directory: string) {
    const [_, setStore] = child(directory)
    const sdk = createSynergyClient({
      baseUrl: globalSDK.url,
      directory,
      throwOnError: true,
    })

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
          const directories = Object.keys(children)
          Promise.all([
            loadConfigSets(),
            loadGlobalProviders(),
            ...directories.map((directory) => refreshConfig(directory)),
          ] as Promise<void>[])
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
    const directories = Object.keys(children)

    const globalPromises: Promise<unknown>[] = []
    const perScopePromises: Promise<unknown>[] = []

    if (targets.has("config") || targets.has("provider")) {
      globalPromises.push(loadGlobalProviders())
      globalPromises.push(loadConfigSets())
    }

    for (const directory of directories) {
      const [_, setStore] = child(directory)
      const sdk = createSynergyClient({
        baseUrl: globalSDK.url,
        directory,
        throwOnError: true,
      })

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

      perScopePromises.push(Promise.all(scopePromises))
    }

    await Promise.all([...globalPromises, ...perScopePromises])
  }

  async function loadSessions(directory: string, params?: { offset?: number; limit?: number; search?: string }) {
    const [_, setStore] = child(directory)
    const query = new URLSearchParams()
    if (directory) query.set("directory", directory)
    query.set("offset", String(params?.offset ?? 0))
    query.set("limit", String(params?.limit ?? 20))
    if (params?.search) query.set("search", params.search)
    return fetch(`${globalSDK.url}/session?${query}`)
      .then((res) => res.json())
      .then((result: { data: Session[]; total: number; offset: number; limit: number }) => {
        const sessions = (result.data ?? []).filter((s) => !!s?.id && !s.time?.archived)
        batch(() => {
          setStore("session", reconcile(sessions, { key: "id" }))
          setStore("sessionTotal", result.total)
        })
      })
      .catch((err) => {
        console.error("Failed to load sessions", err)
        const project = getFilename(directory)
        showToast({ title: `Failed to load sessions for ${project}`, description: err.message })
      })
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const isGlobal = isGlobalScope(directory)
    const [store, setStore] = child(directory)
    const sdk = createSynergyClient({
      baseUrl: globalSDK.url,
      directory,
      throwOnError: true,
    })

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
    blockingRequests.scopeID = isGlobal
      ? () => Promise.resolve(setStore("scopeID", "global"))
      : () => sdk.scope.current().then((x) => setStore("scopeID", x.data!.id))
    await Promise.all(Object.values(blockingRequests).map((p) => retry(p).catch((e) => setGlobalStore("error", e))))
      .then(async () => {
        if (store.status !== "complete") setStore("status", "partial")
        const requests: Promise<unknown>[] = [
          sdk.path.get().then((x) => setStore("path", x.data!)),
          sdk.command.list().then((x) => setStore("command", x.data ?? [])),
          sdk.session.status().then((x) => setStore("session_status", x.data!)),
          loadSessions(directory),
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
          sdk.permission.list().then((x) => {
            const grouped: Record<string, PermissionRequest[]> = {}
            for (const perm of x.data ?? []) {
              if (!perm?.id || !perm.sessionID) continue
              const existing = grouped[perm.sessionID]
              if (existing) {
                existing.push(perm)
                continue
              }
              grouped[perm.sessionID] = [perm]
            }

            batch(() => {
              for (const sessionID of Object.keys(store.permission)) {
                if (grouped[sessionID]) continue
                setStore("permission", sessionID, [])
              }
              for (const [sessionID, permissions] of Object.entries(grouped)) {
                setStore(
                  "permission",
                  sessionID,
                  reconcile(
                    permissions
                      .filter((p) => !!p?.id)
                      .slice()
                      .sort((a, b) => a.id.localeCompare(b.id)),
                    { key: "id" },
                  ),
                )
              }
            })
          }),
          sdk.question.list().then((x) => {
            const grouped: Record<string, QuestionRequest[]> = {}
            for (const req of x.data ?? []) {
              if (!req?.id || !req.sessionID) continue
              const existing = grouped[req.sessionID]
              if (existing) {
                existing.push(req)
                continue
              }
              grouped[req.sessionID] = [req]
            }

            batch(() => {
              for (const sessionID of Object.keys(store.question)) {
                if (grouped[sessionID]) continue
                setStore("question", sessionID, [])
              }
              for (const [sessionID, questions] of Object.entries(grouped)) {
                setStore(
                  "question",
                  sessionID,
                  reconcile(
                    questions
                      .filter((q) => !!q?.id)
                      .slice()
                      .sort((a, b) => a.id.localeCompare(b.id)),
                    { key: "id" },
                  ),
                )
              }
            })
          }),
        ]
        if (!isGlobal) {
          requests.push(sdk.lsp.status().then((x) => setStore("lsp", x.data!)))
          requests.push(sdk.vcs.get().then((x) => setStore("vcs", x.data)))
        }
        await Promise.all(requests)
        setStore("status", "complete")
      })
      .catch((e) => setGlobalStore("error", e))
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name === "global" ? "global" : e.name
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

    if (event?.type === "config.updated" || (event as { type?: string }).type === "config.set.activated") {
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

    const [store, setStore] = child(directory)
    switch (event.type) {
      case "server.instance.disposed": {
        bootstrapInstance(directory)
        break
      }
      case "session.updated": {
        const info = event.properties.info as Session
        const result = Binary.search(store.session, info.id, (s) => s.id)
        if (info.time.archived) {
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        if (result.found) {
          setStore("session", result.index, reconcile(info))
          break
        }
        setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 0, info)
          }),
        )
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
        setStore("session_status", event.properties.sessionID, reconcile(event.properties.status))
        break
      }
      case "message.updated": {
        const messages = store.message[event.properties.info.sessionID]
        if (!messages) {
          setStore("message", event.properties.info.sessionID, [event.properties.info])
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          break
        }
        setStore(
          "message",
          event.properties.info.sessionID,
          produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }),
        )
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
          break
        }
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          setStore("part", part.messageID, result.index, part)
          break
        }
        setStore(
          "part",
          part.messageID,
          produce((draft) => {
            draft.splice(result.index, 0, part)
          }),
        )
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
      case "permission.allowAll.changed": {
        const updates = (
          event.properties as {
            sessions?: Array<{
              sessionID: string
              enabled: boolean
            }>
          }
        ).sessions
        if (!updates) break
        setStore(
          "session",
          produce((draft) => {
            for (const update of updates) {
              const result = Binary.search(draft, update.sessionID, (session) => session.id)
              if (!result.found) continue
              ;(draft[result.index] as (typeof draft)[number] & { allowAll?: boolean }).allowAll = update.enabled
            }
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
        const sdk = createSynergyClient({
          baseUrl: globalSDK.url,
          directory,
          throwOnError: true,
        })
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
  onCleanup(unsub)

  let wasConnected = false
  createEffect(() => {
    const isConnected = globalSDK.connected()
    if (isConnected && !wasConnected && globalStore.ready) {
      for (const directory of Object.keys(children)) {
        const [store, setStore] = child(directory)
        const activeSessions = store.session.filter((s) => {
          const status = store.session_status[s.id]
          return status?.type === "busy" || status?.type === "retry"
        })
        if (activeSessions.length > 0) {
          loadSessions(directory)
        }
        const scopeSdk = createSynergyClient({ baseUrl: globalSDK.url, directory, throwOnError: true })
        scopeSdk.session
          .status()
          .then((x) => setStore("session_status", x.data!))
          .catch(() => {})
      }
      loadGlobalAgenda()
    }
    wasConnected = isConnected
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
        globalSDK.client.path.get().then((x) => {
          setGlobalStore("path", x.data!)
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
      retry(() => loadConfigSets()),
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
    child,
    releaseChild,
    bootstrap,
    noteVersion,
    get agenda() {
      return globalStore.agenda
    },
    get configSets() {
      return globalStore.config_sets
    },
    loadGlobalAgenda,
    loadConfigSets,
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
