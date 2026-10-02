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
import { contentBudgetKey } from "./content-budget"
import { clearConversationContent } from "./conversation-content-state"
import { refreshPlanBlueprintOfferFromLoadedParts, updatePlanBlueprintOfferState } from "./global-sync"
import { createSessionMessageLoader, type SessionMessageLoadState } from "./session-message-loader"
import { requestErrorMessage } from "@/utils/error"
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
    const partPages = new Map<string, Promise<void>>()
    const retainedContent = globalSync.retainContentCache(sdk.scopeKey, () =>
      createPartMaterializer({
        memory: globalSync.contentBudget,
        memoryKey: (summary) => contentBudgetKey(sdk.scopeKey, summary.messageID, summary.id),
        read: async (summary, signal) => {
          const cached = store.part[summary.messageID]?.find((part) => part.id === summary.id)
          if (cached && store.partVersion[summary.id] === summary.content.version)
            return { part: cached, version: summary.content.version }
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
        isCurrent: (summary) => {
          const current = store.partSummary[summary.messageID]?.find((item) => item.id === summary.id)
          return !current || current.content.version === summary.content.version
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
      options?: { partID?: string; older?: boolean },
    ): Promise<void> => {
      const pending = partPages.get(messageID)
      if (pending)
        return pending.then(() => {
          if (options?.partID && !store.partSummary[messageID]?.some((part) => part.id === options.partID))
            return loadPartSummaries(sessionID, messageID, false, true, options)
        })
      if (!force && !more && store.partPage[messageID]) return Promise.resolve()
      const cursor = more
        ? options?.older
          ? store.partPage[messageID]?.previousCursor
          : store.partPage[messageID]?.nextCursor
        : undefined
      if (more && !cursor) return Promise.resolve()
      const request = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const freshness = globalSync.capturePartSnapshotRequest(sdk.scopeKey, sessionID)
          const response = await sdk.client.session.partPage(
            {
              sessionID,
              messageID,
              cursor: cursor ?? undefined,
              partID: options?.partID,
              older: options?.older,
              limit: 100,
            },
            { signal: contentLifetime.signal, throwOnError: true },
          )
          const page = response.data
          if (!page || contentLifetime.signal.aborted) return
          const action = globalSync.partSnapshotAction(sdk.scopeKey, sessionID, messageID, freshness)
          if (action === "retry") continue
          const previous = store.partPage[messageID]
          const current = store.partSummary[messageID] ?? []
          const items = new Map((more || action === "preserve" ? current : []).map((part) => [part.id, part]))
          for (const part of page.items)
            items.set(part.id, action === "preserve" ? (current.find((item) => item.id === part.id) ?? part) : part)
          batch(() => {
            setStore(
              "partSummary",
              messageID,
              reconcile(
                [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
                { key: "id" },
              ),
            )
            setStore("partPage", messageID, {
              nextCursor: more && options?.older ? (previous?.nextCursor ?? page.nextCursor) : page.nextCursor,
              hasMore: more && options?.older ? (previous?.hasMore ?? page.hasMore) : page.hasMore,
              previousCursor: more && !options?.older ? (previous?.previousCursor ?? null) : page.previousCursor,
              hasEarlier: more && !options?.older ? (previous?.hasEarlier ?? false) : page.hasEarlier,
            })
          })
          return
        }
        throw new Error("Conversation summary changed while loading")
      })().finally(() => partPages.delete(messageID))
      partPages.set(messageID, request)
      return request
    }
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
      if (!options?.force && getSession(sessionID) !== undefined) return

      await retry(() => sdk.client.session.get({ sessionID })).then((session) => {
        if (!session.data) return
        upsertSession(session.data)
      })
    }

    const markSessionSynced = (sessionID: string, reconnectVersion: number) => {
      const current = sessionReconnectVersions.get(sessionID) ?? -1
      if (reconnectVersion > current) sessionReconnectVersions.set(sessionID, reconnectVersion)
    }

    type SessionMessagePageResponse = Awaited<ReturnType<(typeof sdk.client.session)["timelinePage"]>>
    type SessionMessagePageLoadResult = {
      response: SessionMessagePageResponse
      request?: SyncResourceRequest
      contextProjectionRevision?: number
      latestContextMessage?: Message | null
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
          retry(() =>
            sdk.client.session.timelinePage(
              {
                sessionID,
                cursor,
                limit,
                messageID,
              },
              { signal, throwOnError: true },
            ),
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
        return { response, request, contextProjectionRevision, partSnapshotRequest, latestContextMessage }
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
        const apply = () => {
          batch(() => {
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

    onCleanup(messageLoader.dispose)

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
          // The permission route is cross-Scope; the sessionID filter keeps
          // the payload bounded while the response still seeds the global
          // index. `seedSessionPermissions` replaces this session's slice and
          // keeps any request whose event write postdates the response stamp.
          const syncPermissions = () =>
            retry(() => sdk.client.permission.list({ sessionID }))
              .then((res) => globalSync.seedSessionPermissions(sessionID, res.data ?? [], res.response?.headers))
              .catch(() => {})
          // Force session/message reloads after reconnect or backend restart.
          // Session metadata alone is not enough: tool parts publish as
          // unsequenced streaming events, so reconnect recovery must re-fetch
          // durable message/part snapshots too (issue #509 / #331).
          const currentReconnectVersion = globalSync.scopeReconnectVersion(sdk.scopeKey)
          const session = getSession(sessionID)
          const plan = planSessionSyncReload({
            hasSessionRecord: session !== undefined,
            hasMessages: hasMessageSnapshot(sessionID),
            reconnectVersion: currentReconnectVersion,
            lastSyncedReconnectVersion: sessionReconnectVersions.get(sessionID),
            canUnrollback: session?.history?.rollback?.canUnrollback === true,
            trigger: options?.trigger,
          })
          const target: SessionSyncTarget = {
            reconnectVersion: currentReconnectVersion,
            forceSession: plan.forceSession,
            forceMessages: plan.forceMessages,
          }
          const reloadMessages = () => {
            const messages = store.message[sessionID]
            if (
              store.messageWindow[sessionID]?.mode === "history" &&
              messages?.length &&
              !plan.needsDerivedHistoryRefresh &&
              options?.trigger?.type !== "history-transition"
            )
              return loadMessagePage(
                sessionID,
                {
                  mode: "history",
                  limit: 100,
                  retainedWindow: { first: messages[0], last: messages.at(-1)!, count: messages.length },
                },
                { force: true, reconnectVersion: currentReconnectVersion },
              )
            return loadLatestMessages(sessionID, { force: true, reconnectVersion: currentReconnectVersion })
          }
          const runBaseSync = async () => {
            await Promise.all([
              plan.forceSession ? loadSession(sessionID, { force: true }) : Promise.resolve(),
              plan.forceMessages ? reloadMessages() : Promise.resolve(),
            ])
            if (!plan.forceMessages) markSessionSynced(sessionID, currentReconnectVersion)
          }
          const active = plan.ready ? undefined : inflight.get(sessionID)
          const baseReq = plan.ready
            ? Promise.resolve()
            : active && options?.trigger
              ? trackSessionSync(inflight, sessionID, target, refreshSessionAfterPending(active.request, runBaseSync))
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
        async refresh(sessionID: string) {
          const reconnectVersion = globalSync.scopeReconnectVersion(sdk.scopeKey)
          await Promise.all([
            loadSession(sessionID, { force: true }).catch(() => {}),
            loadLatestMessages(sessionID, { force: true, reconnectVersion }),
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
          async locate(sessionID: string, messageID: string, partID?: string) {
            if (!store.message[sessionID]?.some((message) => message.id === messageID))
              await loadMessagePage(sessionID, { mode: "history", targetMessageID: messageID, limit: 50 })
            if (!store.message[sessionID]?.some((message) => message.id === messageID)) return false
            if (partID && !store.partSummary[messageID]?.some((part) => part.id === partID))
              await loadPartSummaries(sessionID, messageID, false, true, { partID })
            else await loadPartSummaries(sessionID, messageID)
            return !partID || store.partSummary[messageID]?.some((part) => part.id === partID) === true
          },
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
          tailMissingLatest(sessionID: string) {
            return store.messageWindow[sessionID]?.tailMissingLatest ?? false
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
              loadLatest: () =>
                loadLatestMessages(sessionID, {
                  force: true,
                  reconnectVersion: globalSync.scopeReconnectVersion(sdk.scopeKey),
                }),
            })
          },
          async returnLatest(sessionID: string) {
            await loadLatestMessages(sessionID, {
              force: true,
              reconnectVersion: globalSync.scopeReconnectVersion(sdk.scopeKey),
            })
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
