import { projectWorkspaceBinding } from "./workspace-catalog"
import { batch, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part, Session, SessionPartSummary } from "@ericsanchezok/synergy-sdk/client"
import { createPartMaterializer } from "./part-materializer"
import {
  createPartSummaryLoader,
  planPartSummaryPage,
  readPartSummaryRanges,
  PartSummarySupersededError,
  partSummaryPageState,
} from "./part-summary-loader"
import { createPartPageBatchReader, isPlainPartPageQuery } from "./part-page-batch"
import type { SessionPartPage } from "@ericsanchezok/synergy-sdk/client"
import { contentBudgetKey } from "./content-budget"
import { clearConversationContent } from "./conversation-content-state"
import { refreshPlanBlueprintOfferFromLoadedParts, updatePlanBlueprintOfferState } from "./global-sync"
import { createSessionMessageLoader, type SessionMessageLoadState } from "./session-message-loader"
import { requestErrorMessage, retryStorageRequest } from "@/utils/error"
import {
  planSessionSyncReload,
  queueSessionSync,
  refreshSessionAfterPending,
  trackSessionSync,
  type SessionSyncTarget,
  type TrackedSessionSync,
  type SessionSyncTrigger,
} from "./session-sync-plan"
import { compareByTimeThenId, hasMessageWindowSnapshot, type MessageWindowState } from "./session-message-window"
import { findLatestSessionContextUsageMessage } from "./session-context-usage"
import { planMessagePageApply } from "./session-message-page"
import { loadOlderOrRecoverLatest } from "./session-message-page-recovery"
import type { SyncResourceRequest } from "./sync-resource-freshness"
import { internMessages, internParts } from "./string-intern"
import { findSessionByID, findSessionIndex } from "./session-collection"
import {
  cachedPartPageSnapshot,
  readSessionViewportContent,
  planSessionViewportContent,
  type SessionViewportContent,
} from "./session-viewport-content"

type RefreshOptions = { force?: boolean }
type SessionSyncOptions = { refreshVolatile?: boolean; trigger?: SessionSyncTrigger }

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()
    const scope = globalSync.retainScopeState(sdk.scopeKey)
    onCleanup(scope.release)
    const [store, setStore] = scope.state
    const contentLifetime = new AbortController()
    const isRequestOwnerCurrent = (sessionID: string, request: SyncResourceRequest) =>
      !contentLifetime.signal.aborted &&
      globalSync.peekScopeState(sdk.scopeKey)?.[0] === store &&
      globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "message").generation === request.generation
    const readPartPageBatch = createPartPageBatchReader({
      read: async (sessionID, messageIDs, batchSignal) => {
        const result = await sdk.client.session.partPages(
          { sessionID, messageIDs, limit: 100 },
          { signal: batchSignal, throwOnError: true },
        )
        if (!result.data) throw new Error("Missing conversation summaries")
        return result.data
      },
    })
    const partPages = createPartSummaryLoader({
      page: (messageID) => store.partPage[messageID],
      summaries: (messageID) => store.partSummary[messageID] ?? [],
      read: async (request, cursor, signal, refresh) => {
        if (globalSync.peekScopeState(sdk.scopeKey)?.[0] !== store) throw new PartSummarySupersededError()
        const freshness = globalSync.capturePartSnapshotRequest(sdk.scopeKey, request.sessionID)
        const read = async (query: {
          cursor?: string
          partID?: string
          older?: boolean
          limit: number
        }): Promise<SessionPartPage> => {
          if (query.limit === 100 && isPlainPartPageQuery(query))
            return readPartPageBatch(request.sessionID, request.messageID, signal)
          const response = await sdk.client.session.partPage(
            { sessionID: request.sessionID, messageID: request.messageID, ...query },
            { signal, throwOnError: true },
          )
          if (!response.data) throw new Error("Missing conversation summary")
          return response.data
        }
        const page = refresh
          ? await readPartSummaryRanges({ page: refresh.page, accepted: refresh.versions, signal, read })
          : await read({ cursor, partID: request.partID, older: request.older, limit: 100 }).then((page) => ({
              ...page,
              ranges: partSummaryPageState(page).ranges,
            }))
        return {
          page,
          action:
            globalSync.peekScopeState(sdk.scopeKey)?.[0] !== store
              ? "retry"
              : globalSync.partSnapshotAction(sdk.scopeKey, request.sessionID, request.messageID, freshness),
        }
      },
      apply: (request, page, action, refresh) => {
        const planned = planPartSummaryPage(
          store.partSummary[request.messageID] ?? [],
          store.partPage[request.messageID],
          page,
          request,
          action,
          refresh,
        )
        batch(() => {
          for (const partID of planned.removedIDs) {
            materializer.invalidate(request.messageID, partID)
            globalSync.contentBudget.remove(contentBudgetKey(sdk.scopeKey, request.messageID, partID))
          }
          if (planned.removedIDs.length) {
            const removed = new Set(planned.removedIDs)
            setStore("part", request.messageID, (parts) => (parts ?? []).filter((part) => !removed.has(part.id)))
            setStore(
              "partVersion",
              produce((versions) => {
                for (const partID of removed) delete versions[partID]
              }),
            )
          }
          setStore("partSummary", request.messageID, reconcile(planned.items, { key: "id" }))
          setStore("partPage", request.messageID, reconcile(planned.page))
        })
      },
    })
    const retainedContent = globalSync.retainContentCache(sdk.scopeKey, (contentSignal) =>
      createPartMaterializer({
        memory: globalSync.contentBudget,
        memoryKey: (summary) => contentBudgetKey(sdk.scopeKey, summary.messageID, summary.id),
        read: async (summary) => {
          const cached = store.part[summary.messageID]?.find((part) => part.id === summary.id)
          if (cached && store.partVersion[summary.id] === summary.content.version)
            return { part: cached, version: summary.content.version }
          return globalSync.partContentStore.read(
            { url: sdk.url, scopeKey: sdk.scopeKey, partID: summary.id, version: summary.content.version },
            async (signal) => {
              const response = await sdk.client.session.partContent(
                {
                  sessionID: summary.sessionID,
                  messageID: summary.messageID,
                  partID: summary.id,
                  version: summary.content.version,
                },
                { signal, throwOnError: true },
              )
              if (!response.data) throw new Error("Missing conversation content")
              return response.data
            },
            contentSignal,
          )
        },
        refresh: async (summary, signal) => {
          const current = store.partSummary[summary.messageID]?.find((part) => part.id === summary.id)
          if (!current || current.content.version !== summary.content.version) return current
          await loadPartSummaries(summary.sessionID, summary.messageID, false, true, {
            partID: summary.id,
            version: summary.content.version,
            signal,
          })
          return store.partSummary[summary.messageID]?.find((part) => part.id === summary.id)
        },
        isCurrent: (summary) => {
          const current = store.partSummary[summary.messageID]?.find((item) => item.id === summary.id)
          return current?.content.version === summary.content.version
        },
        apply: (part, summary) => {
          setStore("partVersion", part.id, summary.content.version)
          const parts = store.part[part.messageID] ?? []
          const index = parts.findIndex((item) => item.id === part.id)
          if (index >= 0) setStore("part", part.messageID, index, reconcile(part))
          else
            setStore(
              "part",
              part.messageID,
              [...parts, part].sort((a, b) => a.id.localeCompare(b.id)),
            )
        },
        evict: (summary) => {
          if (store.partVersion[summary.id] && store.partVersion[summary.id] !== summary.content.version) return
          setStore("part", summary.messageID, (parts) => (parts ?? []).filter((part) => part.id !== summary.id))
        },
        subscribe: (summary) => sdk.content.retain(sdk.scopeKey, summary),
      }),
    )
    const materializer = retainedContent.cache
    onCleanup(() => {
      contentLifetime.abort()
      retainedContent.release()
    })
    const loadPartSummaries = (
      sessionID: string,
      messageID: string,
      more = false,
      force = false,
      options?: { partID?: string; older?: boolean; version?: string; signal?: AbortSignal },
    ): Promise<void> =>
      partPages.load(
        {
          sessionID,
          messageID,
          more,
          force,
          partID: options?.partID,
          older: options?.older,
          version: options?.version,
        },
        options?.signal ?? contentLifetime.signal,
      )
    const absolute = (path: string) => (store.path.directory + "/" + path).replace("//", "/")
    const chunk = 200

    // The initial latest page only needs to fill the rendered turn bound
    // (MAX_RENDERED_TURNS in pages/session.tsx), not the whole transcript;
    // history prepends keep the larger page so "Load earlier" refills the cap.
    const INITIAL_LATEST_PAGE_LIMIT = 100
    const inflight = new Map<string, TrackedSessionSync>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightInbox = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const inflightDag = new Map<string, Promise<void>>()
    const navigation = new Map<string, { key: string; promise: Promise<unknown> }>()
    const [meta, setMeta] = createStore({
      messageLoad: {} as Record<string, SessionMessageLoadState>,
      messageNavigation: {} as Record<string, string | undefined>,
    })
    // Track the reconnectVersion at the time of each session's last successful
    // message/part snapshot load. After reconnect, force both session metadata
    // and durable message/part reloads: tool parts publish as unsequenced
    // streaming events, so event replay alone cannot restore a missed tool card
    // (issue #509). Session metadata still follows the same restart pattern as
    // blueprint loop refetch (issue #331).
    const sessionReconnectVersions = new Map<string, number>()

    const getSession = (sessionID: string) => findSessionByID(store.session, sessionID)
    const hasMessageSnapshot = (sessionID: string) =>
      hasMessageWindowSnapshot(store.message[sessionID], store.messageWindow[sessionID])

    const reconcileCortexFromSession = (session: Session) => globalSync.reconcileCortexFromSession(session)

    const upsertSession = (incoming: Session) => {
      const session = incoming.workspaceID
        ? {
            ...incoming,
            workspace: projectWorkspaceBinding(
              incoming.workspace,
              store.workspaces.find((record) => record.id === incoming.workspaceID),
              { workspaceID: incoming.workspaceID, scopeID: incoming.scope.id },
            ),
          }
        : incoming
      reconcileCortexFromSession(session)
      const index = findSessionIndex(store.session, session.id)
      if (index !== -1) {
        // reconcile so a re-fetch of an already-present session preserves object
        // identity and doesn't invalidate downstream memos (issue #319).
        setStore("session", index, reconcile(session))
        return
      }
      setStore(
        "session",
        produce((draft) => {
          draft.unshift(session)
        }),
      )
    }

    const loadSession = async (sessionID: string, options?: RefreshOptions) => {
      contentLifetime.signal.throwIfAborted()
      if (!options?.force && getSession(sessionID) !== undefined) return
      const request = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "message")
      await retry(() => sdk.client.session.get({ sessionID }, { signal: contentLifetime.signal, throwOnError: true }), {
        signal: contentLifetime.signal,
      }).then((session) => {
        if (!session.data || !isRequestOwnerCurrent(sessionID, request)) return
        upsertSession(session.data)
      })
    }

    const markSessionSynced = (sessionID: string, reconnectVersion: number) => {
      const current = sessionReconnectVersions.get(sessionID) ?? -1
      if (reconnectVersion > current) sessionReconnectVersions.set(sessionID, reconnectVersion)
    }

    const computeReloadPlan = (sessionID: string, reconnectVersion: number, trigger?: SessionSyncTrigger) => {
      const session = getSession(sessionID)
      return planSessionSyncReload({
        hasSessionRecord: session !== undefined,
        hasMessages: hasMessageSnapshot(sessionID),
        reconnectVersion,
        lastSyncedReconnectVersion: sessionReconnectVersions.get(sessionID),
        canUnrollback: session?.history?.rollback?.canUnrollback === true,
        trigger,
      })
    }

    type SessionMessagePageResponse = Awaited<ReturnType<(typeof sdk.client.session)["timelinePage"]>>
    type SessionMessagePageLoadResult = {
      response: SessionMessagePageResponse
      request?: SyncResourceRequest
      contextProjectionRevision?: number
      latestContextMessage?: Message | null
      viewport?: SessionViewportContent
      partSnapshotRequest: ReturnType<typeof globalSync.capturePartSnapshotRequest>
    }
    type MessagePageLoadInput = {
      mode: "latest" | "history"
      cursor?: string
      reconnectVersion?: number
      limit: number
      targetMessageID?: string
      retainedWindow?: { first: Message; last: Message; count: number }
    }
    const messageLoader = createSessionMessageLoader<SessionMessagePageLoadResult, MessagePageLoadInput>({
      request: async (sessionID, signal, input) => {
        const request =
          input?.mode === "latest" || input?.retainedWindow
            ? globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "message")
            : undefined
        const contextProjectionRevision =
          input?.mode === "latest" || input?.retainedWindow
            ? globalSync.beginContextProjection(sdk.scopeKey, sessionID)
            : undefined
        const partSnapshotRequest = globalSync.capturePartSnapshotRequest(sdk.scopeKey, sessionID)
        const read = (cursor?: string, limit = 100, messageID?: string) =>
          retryStorageRequest(
            () =>
              sdk.client.session.timelinePage(
                {
                  sessionID,
                  cursor,
                  limit,
                  messageID,
                },
                { signal, throwOnError: true },
              ),
            { signal },
          )
        const retained = input?.retainedWindow
        let response = await read(
          input?.cursor,
          Math.min(100, retained?.count ?? input?.limit ?? chunk),
          retained?.last.id ?? input?.targetMessageID,
        )
        const initial = response
        let latestContextMessage: Message | null | undefined
        if (retained && response.data) {
          const items = [...response.data.items]
          const roots = new Map(response.data.referencedRoots.map((entry) => [entry.info.id, entry]))
          while (
            response.data.hasMore &&
            response.data.nextCursor &&
            items.length < retained.count &&
            items[0] &&
            compareByTimeThenId(items[0].info, retained.first) > 0
          ) {
            response = await read(response.data.nextCursor, Math.min(100, retained.count - items.length))
            if (!response.data?.items.length) break
            items.unshift(...response.data.items)
            for (const entry of response.data.referencedRoots) roots.set(entry.info.id, entry)
          }
          if (response.data)
            response = {
              ...initial,
              data: { ...response.data, items, referencedRoots: [...roots.values()] },
            }
          const latest = await read()
          latestContextMessage = findLatestSessionContextUsageMessage(
            latest.data?.items.map((entry) => entry.info) ?? [],
          )
        }
        const viewport =
          input?.mode === "latest" && !hasMessageSnapshot(sessionID) && response.data
            ? await readSessionViewportContent({
                messages: [...response.data.referencedRoots, ...response.data.items].map((entry) => entry.info),
                signal,
                page: (messageID) => {
                  const cached = cachedPartPageSnapshot(store.partSummary[messageID], store.partPage[messageID])
                  return cached ? Promise.resolve(cached) : readPartPageBatch(sessionID, messageID, signal)
                },
                body: (summary) =>
                  globalSync.partContentStore.readThrough({
                    url: sdk.url,
                    scopeKey: sdk.scopeKey,
                    partID: summary.id,
                    version: summary.content.version,
                    bytes: summary.content.bytes,
                    read: async () => {
                      const result = await sdk.client.session.partContent(
                        {
                          sessionID,
                          messageID: summary.messageID,
                          partID: summary.id,
                          version: summary.content.version,
                        },
                        { signal, throwOnError: true },
                      )
                      if (!result.data) throw new Error("Missing conversation content")
                      return result.data
                    },
                  }),
              })
            : undefined
        return { response, request, contextProjectionRevision, partSnapshotRequest, latestContextMessage, viewport }
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
          tailMissingLatest: currentMetadata?.tailMissingLatest ?? false,
        }
        const plan = planMessagePageApply<Message, Part>({
          page,
          current,
          mode: input?.mode,
          replace: !!input?.targetMessageID || !!input?.retainedWindow,
        })
        const partActions = new Map(
          Object.keys(plan.parts).map((messageID) => [
            messageID,
            globalSync.partSnapshotAction(sdk.scopeKey, sessionID, messageID, result.partSnapshotRequest),
          ]),
        )
        if ([...partActions.values()].some((action) => action === "retry")) return "superseded"
        const viewport = planSessionViewportContent(result.viewport, (messageID) =>
          globalSync.partSnapshotAction(sdk.scopeKey, sessionID, messageID, result.partSnapshotRequest),
        )
        if (!viewport) return "superseded"
        const apply = () => {
          batch(() => {
            if (Object.keys(viewport.pages).length) globalSync.seedSessionViewportContent(sdk.scopeKey, viewport)
            for (const messageID of plan.droppedIds) materializer.invalidate(messageID)
            setStore(
              produce((draft) => {
                for (const messageID of plan.droppedIds) {
                  clearConversationContent(draft, messageID)
                }
              }),
            )
            setStore("message", sessionID, reconcile(internMessages(plan.window.messages), { key: "id" }))
            setStore("messageWindow", sessionID, reconcile(plan.metadata))
            const latestContextMessage =
              result.latestContextMessage !== undefined ? result.latestContextMessage : plan.latestContextMessage
            if (latestContextMessage !== undefined) {
              globalSync.setLatestContextMessage(
                sdk.scopeKey,
                sessionID,
                latestContextMessage,
                result.contextProjectionRevision,
              )
            }
            for (const [messageID, parts] of Object.entries(plan.parts)) {
              if (partActions.get(messageID) === "preserve") continue
              setStore("part", messageID, reconcile(internParts(parts), { key: "id" }))
            }
          })
          globalSync.touchMessageBucket(sdk.scopeKey, sessionID)
          refreshPlanBlueprintOfferFromLoadedParts(store, setStore, sessionID)
        }

        if (result.request) {
          const accepted = globalSync.applyResourceResponse(
            sdk.scopeKey,
            sessionID,
            "message",
            result.request,
            result.response.response?.headers,
            apply,
          )
          if (accepted && input?.reconnectVersion !== undefined) {
            markSessionSynced(sessionID, input.reconnectVersion)
          }
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

    onCleanup(() => {
      navigation.clear()
      messageLoader.dispose()
    })

    const loadMessagePage = (
      sessionID: string,
      input: MessagePageLoadInput,
      options?: { force?: boolean; reconnectVersion?: number },
    ) =>
      messageLoader.load(sessionID, {
        force: options?.force,
        hasSnapshot: hasMessageSnapshot(sessionID),
        input: { ...input, reconnectVersion: options?.reconnectVersion },
      })

    const loadLatestMessages = (sessionID: string, options?: { force?: boolean; reconnectVersion?: number }) =>
      loadMessagePage(
        sessionID,
        { mode: "latest", limit: hasMessageSnapshot(sessionID) ? chunk : INITIAL_LATEST_PAGE_LIMIT },
        options,
      )

    const navigateMessages = <T,>(sessionID: string, key: string, run: () => Promise<T>): Promise<T> => {
      const previous = navigation.get(sessionID)
      if (previous?.key === key) return previous.promise as Promise<T>
      const promise: Promise<T> = Promise.resolve()
        .then(async () => {
          await previous?.promise.catch(() => {})
          await messageLoader.pending(sessionID)?.catch(() => {})
          contentLifetime.signal.throwIfAborted()
          return run()
        })
        .finally(() => {
          if (navigation.get(sessionID)?.promise !== promise) return
          navigation.delete(sessionID)
          setMeta("messageNavigation", sessionID, undefined)
        })
      navigation.set(sessionID, { key, promise })
      setMeta("messageNavigation", sessionID, key)
      return promise
    }

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
          scopeID: sdk.scopeID,
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
          scopeID: sdk.scopeID,
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
      get reconnectVersion() {
        return globalSync.scopeReconnectVersion(sdk.scopeKey)
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
      rollbackDialog: {
        async markPresented(sessionID: string, rollbackID: string) {
          await retry(() =>
            sdk.client.session.rollbackAck(
              { sessionID, sessionRollbackAckInput: { rollbackID } },
              { throwOnError: true },
            ),
          )
        },
      },
      session: {
        get: getSession,
        content: {
          summaries: loadPartSummaries,
          earlier: (sessionID: string, messageID: string) =>
            loadPartSummaries(sessionID, messageID, true, false, { older: true }),
          retain: (summary: SessionPartSummary) => materializer.retain(summary),
          async text(sessionID: string, messageID: string) {
            const response = await sdk.client.session.historyText(
              { sessionID, messageID },
              { throwOnError: true, signal: contentLifetime.signal },
            )
            return response.data?.text ?? ""
          },
          invalidate: (messageID: string, partID?: string) => materializer.invalidate(messageID, partID),
          get bytes() {
            return materializer.bytes
          },
        },
        latestContextMessage(sessionID: string) {
          return store.latestContextMessage[sessionID]
        },
        loadState(sessionID: string): SessionMessageLoadState {
          const current = meta.messageLoad[sessionID]
          if (current) return current
          if (hasMessageSnapshot(sessionID)) return { phase: "ready", generation: 0, hasSnapshot: true }
          return { phase: "idle", generation: 0, hasSnapshot: false }
        },
        async sync(sessionID: string, options?: SessionSyncOptions) {
          // The Scope's permission response is session-filtered to keep
          // the payload bounded while the response seeds the global
          // index. `seedSessionPermissions` replaces this session's slice and
          // keeps any request whose event write postdates the response stamp.
          const syncPermissions = () =>
            retry(() => sdk.client.permission.list({ sessionID }))
              .then((res) => {
                if (!res.data) throw new Error("Permission snapshot returned no data")
                globalSync.seedSessionPermissions(sessionID, res.data, res.response?.headers, sdk.scopeID)
              })
              .catch(() => {})
          // Force session/message reloads after reconnect or backend restart.
          // Session metadata alone is not enough: tool parts publish as
          // unsequenced streaming events, so reconnect recovery must re-fetch
          // durable message/part snapshots too (issue #509 / #331).
          const reconnectVersion = globalSync.scopeReconnectVersion(sdk.scopeKey)
          const plan = computeReloadPlan(sessionID, reconnectVersion, options?.trigger)
          const target: SessionSyncTarget = {
            reconnectVersion,
            forceSession: plan.forceSession,
            forceMessages: plan.forceMessages,
          }
          const reloadMessages = async (active: ReturnType<typeof computeReloadPlan>) => {
            while (navigation.has(sessionID)) await navigation.get(sessionID)!.promise.catch(() => {})
            contentLifetime.signal.throwIfAborted()
            const messages = store.message[sessionID]
            if (
              store.messageWindow[sessionID]?.mode === "history" &&
              messages?.length &&
              !active.needsDerivedHistoryRefresh &&
              options?.trigger?.type !== "history-transition"
            )
              return loadMessagePage(
                sessionID,
                {
                  mode: "history",
                  limit: 100,
                  retainedWindow: { first: messages[0], last: messages.at(-1)!, count: messages.length },
                },
                { force: true, reconnectVersion },
              )
            return loadLatestMessages(sessionID, { force: true, reconnectVersion })
          }
          // The trigger chain defers this run behind the in-flight base load;
          // by then the window and the sync generation are settled, so the plan
          // captured at invocation time would re-issue an already-accepted wave
          // (HAR cold-load wave 3). Re-plan from live store state at execution.
          const runBaseSync = async (trigger?: SessionSyncTrigger) => {
            const active = computeReloadPlan(sessionID, reconnectVersion, trigger)
            if (active.ready) return
            await Promise.all([
              active.forceSession ? loadSession(sessionID, { force: true }) : Promise.resolve(),
              active.forceMessages ? reloadMessages(active) : Promise.resolve(),
            ])
            if (!active.forceMessages) markSessionSynced(sessionID, reconnectVersion)
          }
          const active = plan.ready ? undefined : inflight.get(sessionID)
          const baseReq = plan.ready
            ? Promise.resolve()
            : active && options?.trigger
              ? trackSessionSync(
                  inflight,
                  sessionID,
                  target,
                  refreshSessionAfterPending(active.request, () => runBaseSync(options?.trigger)),
                )
              : queueSessionSync(inflight, sessionID, target, runBaseSync)

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
        refresh(sessionID: string) {
          return navigateMessages(sessionID, "refresh", async () => {
            const reconnectVersion = globalSync.scopeReconnectVersion(sdk.scopeKey)
            await Promise.all([
              loadSession(sessionID, { force: true }).catch(() => {}),
              loadLatestMessages(sessionID, { force: true, reconnectVersion }),
              refreshVolatile(sessionID),
            ])
          })
        },
        async diff(sessionID: string) {
          contentLifetime.signal.throwIfAborted()
          if (store.session_diff[sessionID] !== undefined) return

          const pending = inflightDiff.get(sessionID)
          if (pending) return pending

          const request = globalSync.captureResourceRequest(sdk.scopeKey, sessionID, "message")
          const promise = retry(
            () => sdk.client.session.diff({ sessionID }, { signal: contentLifetime.signal, throwOnError: true }),
            { signal: contentLifetime.signal },
          )
            .then((diff) => {
              if (!isRequestOwnerCurrent(sessionID, request)) return
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
          locate(sessionID: string, messageID: string, partID?: string) {
            return navigateMessages(sessionID, JSON.stringify(["locate", messageID, partID]), async () => {
              if (!store.message[sessionID]?.some((message) => message.id === messageID))
                await loadMessagePage(
                  sessionID,
                  { mode: "history", targetMessageID: messageID, limit: 50 },
                  { force: true },
                )
              if (!store.message[sessionID]?.some((message) => message.id === messageID)) return false
              if (partID && !store.partSummary[messageID]?.some((part) => part.id === partID))
                await loadPartSummaries(sessionID, messageID, false, true, { partID })
              else await loadPartSummaries(sessionID, messageID)
              return !partID || store.partSummary[messageID]?.some((part) => part.id === partID) === true
            })
          },
          more(sessionID: string) {
            return store.messageWindow[sessionID]?.hasMore ?? false
          },
          loading(sessionID: string) {
            const phase = meta.messageLoad[sessionID]?.phase
            return !!meta.messageNavigation[sessionID] || phase === "loading" || phase === "refreshing"
          },
          mode(sessionID: string) {
            return store.messageWindow[sessionID]?.mode ?? "latest"
          },
          pendingLatest(sessionID: string) {
            return store.messageWindow[sessionID]?.pendingLatest ?? false
          },
          tailMissingLatest(sessionID: string) {
            return store.messageWindow[sessionID]?.tailMissingLatest ?? false
          },
          loadMore(sessionID: string, count = chunk) {
            return navigateMessages(sessionID, "earlier", async () => {
              const metadata = store.messageWindow[sessionID]
              if (!metadata?.hasMore || !metadata.nextCursor) return
              return loadOlderOrRecoverLatest({
                loadOlder: () =>
                  loadMessagePage(
                    sessionID,
                    { mode: "history", cursor: metadata.nextCursor!, limit: count },
                    { force: true },
                  ),
                loadLatest: () =>
                  loadLatestMessages(sessionID, {
                    force: true,
                    reconnectVersion: globalSync.scopeReconnectVersion(sdk.scopeKey),
                  }),
              })
            })
          },
          returnLatest(sessionID: string) {
            return navigateMessages(sessionID, "latest", () =>
              loadLatestMessages(sessionID, {
                force: true,
                reconnectVersion: globalSync.scopeReconnectVersion(sdk.scopeKey),
              }),
            )
          },
        },
      },
      absolute,
      get directory() {
        return store.path.directory
      },
    }
  },
})
