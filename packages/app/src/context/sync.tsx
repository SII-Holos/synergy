import { batch, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part, PermissionRequest, Session } from "@ericsanchezok/synergy-sdk/client"
import { refreshPlanBlueprintOfferFromLoadedParts, updatePlanBlueprintOfferState } from "./global-sync"
import { createSessionMessageLoader, type SessionMessageLoadState } from "./session-message-loader"
import { requestErrorMessage } from "@/utils/error"
import { planSessionSyncReload } from "./session-sync-plan"

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
      messageLoad: {} as Record<string, SessionMessageLoadState>,
    })
    // Track the reconnectVersion at the time of each session's last successful
    // message/part snapshot load. After reconnect, force both session metadata
    // and durable message/part reloads: tool parts publish as unsequenced
    // streaming events, so event replay alone cannot restore a missed tool card
    // (issue #509). Session metadata still follows the same restart pattern as
    // blueprint loop refetch (issue #331).
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
      })
    }

    const markSessionSynced = (sessionID: string) => {
      sessionReconnectVersions.set(sessionID, globalSync.reconnectVersion())
    }

    type SessionMessagesResponse = Awaited<ReturnType<(typeof sdk.client.session)["messages"]>>
    const messageLoader = createSessionMessageLoader<SessionMessagesResponse, { limit: number }>({
      request: (sessionID, signal, input) =>
        retry(() => sdk.client.session.messages({ sessionID, limit: input?.limit ?? chunk }, { signal })),
      apply: (sessionID, messages, input) => {
        const limit = input?.limit ?? chunk
        const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
        const all = items
          .map((x) => x.info)
          .filter((message) => !!message?.id)
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
        const keep = all.length > maxMessages ? all.slice(-maxMessages) : all

        batch(() => {
          setStore("message", sessionID, reconcile(keep, { key: "id" }))
          const keepIds = new Set(keep.map((message) => message.id))
          for (const item of items) {
            if (!keepIds.has(item.info.id)) continue
            setStore(
              "part",
              item.info.id,
              reconcile(
                item.parts
                  .filter((part) => !!part?.id)
                  .slice()
                  .sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            )
          }
          setMeta("limit", sessionID, limit)
          setMeta("complete", sessionID, all.length < limit)
        })
        globalSync.touchMessageBucket(sdk.scopeKey, sessionID)
        refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
      },
      errorMessage: (error) => requestErrorMessage(error, "Couldn’t load conversation"),
      onState: (sessionID, state) => {
        batch(() => {
          setMeta("messageLoad", sessionID, state)
          setMeta("loading", sessionID, state.phase === "loading" || state.phase === "refreshing")
        })
      },
    })

    const loadMessages = (sessionID: string, limit: number, options?: { force?: boolean }) =>
      messageLoader
        .load(sessionID, {
          force: options?.force,
          hasSnapshot: store.message[sessionID] !== undefined,
          input: { limit },
        })
        .then(() => {
          markSessionSynced(sessionID)
        })

    const loadInbox = (sessionID: string, options?: RefreshOptions) => {
      if (!options?.force && store.inbox[sessionID] !== undefined) return

      const pending = inflightInbox.get(sessionID)
      if (pending) return pending

      const request = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "inbox")
      const promise = retry(() => sdk.client.session.inbox({ sessionID }))
        .then((result) => {
          globalSync.applyResourceResponse(sdk.scopeKey, sessionID, "inbox", request, result.response?.headers, () => {
            setStore("inbox", sessionID, reconcile(result.data ?? [], { key: "id" }))
          })
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

      const request = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "todo")
      const promise = retry(() => sdk.client.session.todo({ sessionID }))
        .then((result) => {
          globalSync.applyResourceResponse(sdk.scopeKey, sessionID, "todo", request, result.response?.headers, () => {
            setStore("todo", sessionID, reconcile(result.data ?? [], { key: "id" }))
          })
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

      const request = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "dag")
      const promise = retry(() =>
        sdk.client.session.dag({
          sessionID,
          ...(sdk.isHome ? { scopeID: sdk.scopeID } : { directory: sdk.directory }),
        }),
      )
        .then((result) => {
          globalSync.applyResourceResponse(sdk.scopeKey, sessionID, "dag", request, result.response?.headers, () => {
            setStore("dag", sessionID, reconcile(result.data ?? [], { key: "id" }))
          })
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
        loadState(sessionID: string): SessionMessageLoadState {
          const current = meta.messageLoad[sessionID]
          if (current) return current
          if (store.message[sessionID] !== undefined) {
            return { phase: "ready", generation: 0, hasSnapshot: true }
          }
          return { phase: "idle", generation: 0, hasSnapshot: false }
        },
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
          // Force session/message reloads after reconnect or backend restart.
          // Session metadata alone is not enough: tool parts publish as
          // unsequenced streaming events, so reconnect recovery must re-fetch
          // durable message/part snapshots too (issue #509 / #331).
          const currentReconnectVersion = globalSync.reconnectVersion()
          const session = getSession(sessionID)
          hydrateMessages(sessionID)
          const plan = planSessionSyncReload({
            hasSessionRecord: session !== undefined,
            hasMessages: store.message[sessionID] !== undefined,
            reconnectVersion: currentReconnectVersion,
            lastSyncedReconnectVersion: sessionReconnectVersions.get(sessionID),
            canUnrollback: session?.history?.rollback?.canUnrollback === true,
          })
          const pending = plan.ready ? undefined : inflight.get(sessionID)
          const baseReq =
            pending ??
            (plan.ready
              ? Promise.resolve()
              : (() => {
                  const limit = meta.limit[sessionID] ?? chunk
                  const sessionReq = plan.forceSession ? loadSession(sessionID, { force: true }) : Promise.resolve()
                  const messagesReq = plan.forceMessages
                    ? loadMessages(sessionID, limit, { force: true })
                    : Promise.resolve()
                  const promise = Promise.all([sessionReq, messagesReq])
                    .then(() => {
                      // Session-only reloads (no message fetch) still advance the
                      // reconnect watermark so later sync() calls can short-circuit.
                      if (!plan.forceMessages) markSessionSynced(sessionID)
                    })
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
        // Force a fresh re-fetch of a session's messages and volatile state,
        // bypassing the "already loaded" short-circuit in sync(). Used by the
        // empty-state Refresh button to recover if the initial load missed
        // messages or session metadata such as derived rollback state (issue
        // #328 / #316).
        async refresh(sessionID: string) {
          const limit = meta.limit[sessionID] ?? chunk
          await Promise.all([
            loadSession(sessionID, { force: true }).catch(() => {}),
            loadMessages(sessionID, limit, { force: true }),
            refreshVolatile(sessionID),
          ])
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
      messageLoader.dispose()
      globalSync.releaseScopeState(sdk.scopeKey)
    })
  },
})
