import { batch, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part, PermissionRequest, Session } from "@ericsanchezok/synergy-sdk/client"
import { refreshPlanBlueprintOfferFromLoadedParts, updatePlanBlueprintOfferState } from "./global-sync"

type RefreshOptions = { force?: boolean }
type SessionSyncOptions = { refreshVolatile?: boolean }

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()
    const [store, setStore] = globalSync.ensureScopeState(sdk.scopeKey)
    const absolute = (path: string) => (store.path.directory + "/" + path).replace("//", "/")
    const chunk = 200
    const maxMessages = 500
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightInbox = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const inflightDag = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
      limit: {} as Record<string, number>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })
    // Track the reconnectVersion at the time of each session's last explicit
    // load, so we can force a re-fetch after a backend restart — whose
    // in-memory state the server cannot replay via events. Follows the same
    // pattern as blueprint loop refetch (issue #331). Without this, a session
    // that was already in the store before the restart short-circuits
    // sync.session.sync() and never refreshes persisted metadata such as
    // workflow kind (plan/lightloop/lattice), causing mode chips to disappear.
    const sessionReconnectVersions = new Map<string, number>()

    const getSession = (sessionID: string) => {
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const terminalCortexStatuses = new Set(["completed", "error", "cancelled"])

    const reconcileCortexFromSession = (session: Session) => {
      const cortex = session.cortex
      if (!cortex || !terminalCortexStatuses.has(cortex.status)) return
      const idx = store.cortex.findIndex((task) => task.sessionID === session.id)
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

    const limitFor = (count: number) => {
      if (count <= chunk) return chunk
      return Math.ceil(count / chunk) * chunk
    }

    const hydrateMessages = (sessionID: string) => {
      if (meta.limit[sessionID] !== undefined) return

      const messages = store.message[sessionID]
      if (!messages) return

      const limit = limitFor(messages.length)
      setMeta("limit", sessionID, limit)
      setMeta("complete", sessionID, messages.length < limit)
    }

    const upsertSession = (session: Session) => {
      reconcileCortexFromSession(session)
      const match = Binary.search(store.session, session.id, (s) => s.id)
      if (match.found) {
        // reconcile so a re-fetch of an already-present session preserves object
        // identity and doesn't invalidate downstream memos (issue #319).
        setStore("session", match.index, reconcile(session))
        return
      }
      setStore(
        "session",
        produce((draft) => {
          draft.splice(match.index, 0, session)
        }),
      )
    }

    const loadSession = async (sessionID: string, options?: RefreshOptions) => {
      if (!options?.force && getSession(sessionID) !== undefined) return

      await retry(() => sdk.client.session.get({ sessionID })).then((session) => {
        if (!session.data) return
        upsertSession(session.data)
        sessionReconnectVersions.set(sessionID, globalSync.reconnectVersion())
      })
    }

    const loadMessages = async (sessionID: string, limit: number) => {
      if (meta.loading[sessionID]) return

      setMeta("loading", sessionID, true)
      await retry(() => sdk.client.session.messages({ sessionID, limit }))
        .then((messages) => {
          const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
          const all = items
            .map((x) => x.info)
            .filter((m) => !!m?.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))

          const keep = all.length > maxMessages ? all.slice(-maxMessages) : all

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

            setMeta("limit", sessionID, limit)
            setMeta("complete", sessionID, all.length < limit)
          })
          // Track this bucket for LRU eviction now that it is loaded.
          globalSync.touchMessageBucket(sdk.scopeKey, sessionID)
          refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
        })
        .finally(() => {
          setMeta("loading", sessionID, false)
        })
        .catch(() => {})
    }

    const loadInbox = (sessionID: string, options?: RefreshOptions) => {
      if (!options?.force && store.inbox[sessionID] !== undefined) return

      const pending = inflightInbox.get(sessionID)
      if (pending) return pending

      const promise = retry(() => sdk.client.session.inbox({ sessionID }))
        .then((result) => {
          setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" }))
        })
        .catch(() => {})
        .finally(() => {
          inflightInbox.delete(sessionID)
        })

      inflightInbox.set(sessionID, promise)
      return promise
    }

    const loadTodo = (sessionID: string, options?: RefreshOptions) => {
      if (!options?.force && store.todo[sessionID] !== undefined) return

      const pending = inflightTodo.get(sessionID)
      if (pending) return pending

      const promise = retry(() => sdk.client.session.todo({ sessionID }))
        .then((todo) => {
          setStore("todo", sessionID, reconcile(todo.data ?? [], { key: "id" }))
        })
        .catch(() => {})
        .finally(() => {
          inflightTodo.delete(sessionID)
        })

      inflightTodo.set(sessionID, promise)
      return promise
    }

    const loadDag = (sessionID: string, options?: RefreshOptions) => {
      if (!options?.force && store.dag[sessionID] !== undefined) return

      const pending = inflightDag.get(sessionID)
      if (pending) return pending

      const promise = retry(() =>
        sdk.client.session
          .dag({
            sessionID,
            ...(sdk.isHome ? { scopeID: sdk.scopeID } : { directory: sdk.directory }),
          })
          .then((r) => r.data as any),
      )
        .then((nodes) => {
          setStore("dag", sessionID, reconcile(nodes ?? [], { key: "id" }))
        })
        .catch(() => {})
        .finally(() => {
          inflightDag.delete(sessionID)
        })

      inflightDag.set(sessionID, promise)
      return promise
    }

    const refreshVolatile = async (sessionID: string) => {
      await Promise.all([
        loadInbox(sessionID, { force: true }),
        loadTodo(sessionID, { force: true }),
        loadDag(sessionID, { force: true }),
      ])
    }

    return {
      data: store,
      set: setStore,
      // Protect a session's message/part buckets from LRU eviction while it is
      // the actively-viewed session (pass undefined to clear).
      markActiveSession(sessionID: string | undefined) {
        globalSync.markActiveSession(sdk.scopeKey, sessionID)
      },
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      get scope() {
        const match = Binary.search(globalSync.data.scope, store.scopeID, (p) => p.id)
        if (match.found) return globalSync.data.scope[match.index]
        return undefined
      },
      planBlueprintOffer: {
        dismiss(sessionID: string, key: string) {
          updatePlanBlueprintOfferState(store, setStore, sessionID, { type: "dismissed", key })
        },
        mute(sessionID: string) {
          updatePlanBlueprintOfferState(store, setStore, sessionID, { type: "muted" })
        },
        equip(sessionID: string, key: string) {
          updatePlanBlueprintOfferState(store, setStore, sessionID, { type: "equipped", key })
        },
        refresh(sessionID: string) {
          refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
        },
      },
      session: {
        get: getSession,
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: input.model,
          }
          setStore(
            produce((draft) => {
              const messages = draft.message[input.sessionID]
              if (!messages) {
                draft.message[input.sessionID] = [message]
              } else {
                const result = Binary.search(messages, input.messageID, (m) => m.id)
                messages.splice(result.index, 0, message)
              }
              draft.part[input.messageID] = input.parts
                .filter((p) => !!p?.id)
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
            }),
          )
        },
        async sync(sessionID: string, options?: SessionSyncOptions) {
          const syncPermissions = () =>
            retry(() => sdk.client.permission.list())
              .then((res) => {
                const entries = (res.data ?? [])
                  .filter((entry): entry is PermissionRequest => !!entry?.id && entry.sessionID === sessionID)
                  .slice()
                  .sort((a, b) => a.id.localeCompare(b.id))
                setStore("permission", sessionID, reconcile(entries, { key: "id" }))
              })
              .catch(() => {})

          // Force a session reload after a backend restart, whose in-memory
          // state the server cannot replay via events (same pattern as issue
          // #331 for blueprint loops). Without this, sync() short-circuits
          // because hasSession is true from the stale pre-restart store copy,
          // and persisted fields such as workflow kind (plan/lightloop/lattice)
          // never refresh — causing mode chips to disappear.
          const currentReconnectVersion = globalSync.reconnectVersion()
          const versionStale = sessionReconnectVersions.get(sessionID) !== currentReconnectVersion

          const session = getSession(sessionID)
          const hasSession = session !== undefined && !versionStale
          const needsDerivedHistoryRefresh = session?.history?.rollback?.canUnrollback === true
          hydrateMessages(sessionID)

          const hasMessages = store.message[sessionID] !== undefined
          const ready = hasSession && hasMessages && !needsDerivedHistoryRefresh
          const pending = ready ? undefined : inflight.get(sessionID)
          const baseReq =
            pending ??
            (ready
              ? Promise.resolve()
              : (() => {
                  const limit = meta.limit[sessionID] ?? chunk
                  const sessionReq =
                    hasSession && !needsDerivedHistoryRefresh
                      ? Promise.resolve()
                      : loadSession(sessionID, { force: needsDerivedHistoryRefresh || versionStale })
                  const messagesReq = hasMessages ? Promise.resolve() : loadMessages(sessionID, limit)
                  const promise = Promise.all([sessionReq, messagesReq])
                    .then(() => {})
                    .finally(() => {
                      inflight.delete(sessionID)
                    })
                  inflight.set(sessionID, promise)
                  return promise
                })())

          const requests = [baseReq, syncPermissions()]
          if (options?.refreshVolatile) {
            requests.push(refreshVolatile(sessionID))
          } else {
            const inboxReq = loadInbox(sessionID)
            if (inboxReq) requests.push(inboxReq)
          }

          await Promise.all(requests)
          refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
        },
        async diff(sessionID: string) {
          if (store.session_diff[sessionID] !== undefined) return

          const pending = inflightDiff.get(sessionID)
          if (pending) return pending

          const promise = retry(() => sdk.client.session.diff({ sessionID }))
            .then((diff) => {
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            })
            .finally(() => {
              inflightDiff.delete(sessionID)
            })

          inflightDiff.set(sessionID, promise)
          return promise
        },
        inbox: loadInbox,
        todo: loadTodo,
        dag: loadDag,
        refreshVolatile,
        history: {
          more(sessionID: string) {
            if (store.message[sessionID] === undefined) return false
            if (meta.limit[sessionID] === undefined) return false
            if (meta.complete[sessionID]) return false
            return true
          },
          loading(sessionID: string) {
            return meta.loading[sessionID] ?? false
          },
          async loadMore(sessionID: string, count = chunk) {
            if (meta.loading[sessionID]) return
            if (meta.complete[sessionID]) return

            const current = meta.limit[sessionID] ?? chunk
            await loadMessages(sessionID, current + count)
          },
        },
      },
      absolute,
      get directory() {
        return store.path.directory
      },
    }

    onCleanup(() => {
      globalSync.releaseScopeState(sdk.scopeKey)
    })
  },
})
