import { batch, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, PermissionRequest, Session } from "@ericsanchezok/synergy-sdk/client"
import { refreshPlanBlueprintOfferFromLoadedParts, updatePlanBlueprintOfferState } from "./global-sync"
import { createSessionMessageLoader, type SessionMessageLoadState } from "./session-message-loader"
import { requestErrorMessage } from "@/utils/error"
import { planSessionSyncReload, type SessionSyncTrigger } from "./session-sync-plan"
import type { MessageWindowState } from "./session-message-window"
import { planMessagePageApply } from "./session-message-page"
import { loadOlderOrRecoverLatest } from "./session-message-page-recovery"
import type { SyncResourceRequest } from "./sync-resource-freshness"

type RefreshOptions = { force?: boolean }
type SessionSyncOptions = { refreshVolatile?: boolean; trigger?: SessionSyncTrigger }

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()
    const [store, setStore] = globalSync.ensureScopeState(sdk.scopeKey)
    const absolute = (path: string) => (store.path.directory + "/" + path).replace("//", "/")
    const chunk = 200
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightInbox = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const inflightDag = new Map<string, Promise<void>>()
    const [meta, setMeta] = createStore({
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

    type SessionMessagePageResponse = Awaited<ReturnType<(typeof sdk.client.session)["messagePage"]>>
    type SessionMessagePageLoadResult = {
      response: SessionMessagePageResponse
      request?: SyncResourceRequest
      contextProjectionRevision?: number
      partSnapshotRequest: ReturnType<typeof globalSync.capturePartSnapshotRequest>
    }
    type MessagePageLoadInput = {
      mode: "latest" | "history"
      cursor?: string
      limit: number
    }
    const messageLoader = createSessionMessageLoader<SessionMessagePageLoadResult, MessagePageLoadInput>({
      request: async (sessionID, signal, input) => {
        const request =
          input?.mode === "latest" ? globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "message") : undefined
        const contextProjectionRevision =
          input?.mode === "latest" ? globalSync.beginContextProjection(sdk.scopeKey, sessionID) : undefined
        const partSnapshotRequest = globalSync.capturePartSnapshotRequest(sdk.scopeKey, sessionID)
        const response = await retry(() =>
          sdk.client.session.messagePage(
            {
              sessionID,
              cursor: input?.cursor,
              limit: input?.limit ?? chunk,
            },
            { signal, throwOnError: true },
          ),
        )
        return { response, request, contextProjectionRevision, partSnapshotRequest }
      },
      apply: (sessionID, result, input) => {
        const page = result.response.data
        if (!page) return
        const currentMetadata = store.messageWindow[sessionID]
        const current: MessageWindowState<Message> = {
          messages: store.message[sessionID] ?? [],
          mode: currentMetadata?.mode ?? "latest",
          pendingLatest: currentMetadata?.pendingLatest ?? false,
          pendingLatestIds: currentMetadata?.pendingLatestIds ?? [],
        }
        const plan = planMessagePageApply({ page, current, mode: input?.mode })
        const partActions = new Map(
          Object.keys(plan.parts).map((messageID) => [
            messageID,
            globalSync.partSnapshotAction(sdk.scopeKey, sessionID, messageID, result.partSnapshotRequest),
          ]),
        )
        if ([...partActions.values()].some((action) => action === "retry")) return "superseded"
        const apply = () => {
          batch(() => {
            setStore(
              produce((draft) => {
                for (const messageID of plan.droppedIds) delete draft.part[messageID]
              }),
            )
            setStore("message", sessionID, reconcile(plan.window.messages, { key: "id" }))
            setStore("messageWindow", sessionID, reconcile(plan.metadata))
            if (plan.latestContextMessage !== undefined) {
              globalSync.setLatestContextMessage(
                sdk.scopeKey,
                sessionID,
                plan.latestContextMessage,
                result.contextProjectionRevision,
              )
            }
            for (const [messageID, parts] of Object.entries(plan.parts)) {
              if (partActions.get(messageID) === "preserve") continue
              setStore("part", messageID, reconcile(parts, { key: "id" }))
            }
          })
          globalSync.touchMessageBucket(sdk.scopeKey, sessionID)
          refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
        }

        if (input?.mode === "latest" && result.request) {
          const accepted = globalSync.applyResourceResponse(
            sdk.scopeKey,
            sessionID,
            "message",
            result.request,
            result.response.response?.headers,
            apply,
          )
          return accepted ? "applied" : "superseded"
        }
        // A history prepend changes the window outside latest-page ordering;
        // invalidate any concurrent latest request before applying it.
        globalSync.invalidateResource(sdk.scopeKey, sessionID, "message")
        apply()
        return "applied"
      },
      errorMessage: (error) => requestErrorMessage(error, "Couldn’t load conversation"),
      onState: (sessionID, state) => setMeta("messageLoad", sessionID, state),
    })

    const loadMessagePage = (sessionID: string, input: MessagePageLoadInput, options?: { force?: boolean }) =>
      messageLoader
        .load(sessionID, {
          force: options?.force,
          hasSnapshot: store.message[sessionID] !== undefined,
          input,
        })
        .then(() => {
          markSessionSynced(sessionID)
        })

    const loadLatestMessages = (sessionID: string, options?: { force?: boolean }) =>
      loadMessagePage(sessionID, { mode: "latest", limit: chunk }, options)

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
      const inboxRequest = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "inbox")
      const todoRequest = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "todo")
      const dagRequest = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "dag")
      await retry(() =>
        sdk.client.session.volatileBatch({
          ...(sdk.isHome ? { scopeID: sdk.scopeID } : { directory: sdk.directory }),
          sessionVolatileBatchInput: { sessionIDs: [sessionID] },
        }),
      )
        .then((result) => {
          const state = result.data?.sessions[sessionID]
          if (!state) return
          globalSync.applyResourceResponse(
            sdk.scopeKey,
            sessionID,
            "inbox",
            inboxRequest,
            result.response?.headers,
            () => setStore("inbox", sessionID, reconcile(state.inbox, { key: "id" })),
          )
          globalSync.applyResourceResponse(sdk.scopeKey, sessionID, "todo", todoRequest, result.response?.headers, () =>
            setStore("todo", sessionID, reconcile(state.todo, { key: "id" })),
          )
          globalSync.applyResourceResponse(sdk.scopeKey, sessionID, "dag", dagRequest, result.response?.headers, () =>
            setStore("dag", sessionID, reconcile(state.dag, { key: "id" })),
          )
        })
        .catch(() => {})
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
        latestContextMessage(sessionID: string) {
          return store.latestContextMessage[sessionID]
        },
        loadState(sessionID: string): SessionMessageLoadState {
          const current = meta.messageLoad[sessionID]
          if (current) return current
          if (store.message[sessionID] !== undefined) {
            return { phase: "ready", generation: 0, hasSnapshot: true }
          }
          return { phase: "idle", generation: 0, hasSnapshot: false }
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
          const plan = planSessionSyncReload({
            hasSessionRecord: session !== undefined,
            hasMessages: store.message[sessionID] !== undefined && store.messageWindow[sessionID] !== undefined,
            reconnectVersion: currentReconnectVersion,
            lastSyncedReconnectVersion: sessionReconnectVersions.get(sessionID),
            canUnrollback: session?.history?.rollback?.canUnrollback === true,
            trigger: options?.trigger,
          })
          const pending = plan.ready ? undefined : inflight.get(sessionID)
          const baseReq =
            pending && options?.trigger?.type === "workspace-transition"
              ? Promise.all([pending, loadSession(sessionID, { force: true })]).then(() => undefined)
              : (pending ??
                (plan.ready
                  ? Promise.resolve()
                  : (() => {
                      const sessionReq = plan.forceSession ? loadSession(sessionID, { force: true }) : Promise.resolve()
                      const messagesReq = plan.forceMessages
                        ? loadLatestMessages(sessionID, { force: true })
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
                    })()))

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
          await Promise.all([
            loadSession(sessionID, { force: true }).catch(() => {}),
            loadLatestMessages(sessionID, { force: true }),
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
            return store.messageWindow[sessionID]?.hasMore ?? false
          },
          loading(sessionID: string) {
            const phase = meta.messageLoad[sessionID]?.phase
            return phase === "loading" || phase === "refreshing"
          },
          mode(sessionID: string) {
            return store.messageWindow[sessionID]?.mode ?? "latest"
          },
          pendingLatest(sessionID: string) {
            return store.messageWindow[sessionID]?.pendingLatest ?? false
          },
          async loadMore(sessionID: string, count = chunk) {
            if (this.loading(sessionID)) return
            const metadata = store.messageWindow[sessionID]
            if (!metadata?.hasMore || !metadata.nextCursor) return
            return loadOlderOrRecoverLatest({
              loadOlder: () =>
                loadMessagePage(sessionID, {
                  mode: "history",
                  cursor: metadata.nextCursor!,
                  limit: count,
                }),
              loadLatest: () => loadLatestMessages(sessionID, { force: true }),
            })
          },
          async returnLatest(sessionID: string) {
            await loadLatestMessages(sessionID, { force: true })
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
