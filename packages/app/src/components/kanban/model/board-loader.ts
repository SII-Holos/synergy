import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import { batch } from "solid-js"
import { produce, type SetStoreFunction } from "solid-js/store"
import type { SyncResourceRequest } from "@/context/sync-resource-freshness"
import { createSessionMessageLoader, type SessionMessageLoadState } from "@/context/session-message-loader"
import type { planMessagePageApply } from "@/context/session-message-page"
import type { SessionPartSnapshotAction, SessionPartSnapshotRequest } from "@/context/session-part-snapshot-freshness"
import type { MessageWindowState } from "@/context/session-message-window"
import { internMessages, internParts } from "@/context/string-intern"

export type BoardMessagePageResult = {
  data?: {
    items: { info: Message; parts: Part[] }[]
    referencedRoots: { info: Message; parts: Part[] }[]
    nextCursor: string | null
    hasMore: boolean
    total: number
  }
  response?: { headers?: Pick<Headers, "get"> }
}

type BoardLoadResult = {
  response: BoardMessagePageResult
  request: SyncResourceRequest
  revision: number
  partSnapshotRequest: SessionPartSnapshotRequest
}

type BoardScopeStore = {
  message: Record<string, Message[]>
  messageWindow: Record<string, MessageWindowState<Message>>
  part: Record<string, Part[]>
}

export type BoardLoaderDeps = {
  ensureScopeState: (scopeKey: string) => unknown[]
  captureResourceRequest: (scopeKey: string, sessionID: string, resource: "message") => SyncResourceRequest
  capturePartSnapshotRequest: (scopeKey: string, sessionID: string) => SessionPartSnapshotRequest
  partSnapshotAction: (
    scopeKey: string,
    sessionID: string,
    messageID: string,
    request: SessionPartSnapshotRequest,
  ) => SessionPartSnapshotAction
  beginContextProjection: (scopeKey: string, sessionID: string) => number
  applyResourceResponse: (
    scopeKey: string,
    sessionID: string,
    resource: "message",
    request: SyncResourceRequest,
    headers: Pick<Headers, "get"> | undefined,
    apply: () => void,
  ) => boolean
  setLatestContextMessage: (
    scopeKey: string,
    sessionID: string,
    message: Message | null | undefined,
    revision?: number,
  ) => void
  touchMessageBucket: (scopeKey: string, sessionID: string) => void
  scopeReconnectVersion: (scopeKey: string) => number
  /** Whether the scope store still holds the message-window snapshot for this
   * session (false after the global-sync LRU evicts the bucket). */
  hasBucketSnapshot: (scopeKey: string, sessionID: string) => boolean
  messagePage: (input: {
    scopeRequest: Record<string, string>
    sessionID: string
    limit: number
  }) => Promise<BoardMessagePageResult>
  scopeRequest: (scopeKey: string) => Record<string, string>
  plan: typeof planMessagePageApply
  reconcile: (value: unknown, options?: { key: string }) => unknown
  onStateChange?: (key: string, state: SessionMessageLoadState) => void
}

export type BoardLoader = {
  load: (scopeKey: string, sessionID: string, options?: { force?: boolean }) => void
  state: (scopeKey: string, sessionID: string) => { phase: string; hasSnapshot: boolean; error?: string }
  dispose: () => void
  syncPanes: (panes: { scopeKey: string; sessionID: string }[]) => void
}

const LIMIT = 200

export function createBoardLoader(deps: BoardLoaderDeps): BoardLoader {
  const loader = createSessionMessageLoader<BoardLoadResult, { scopeKey: string; sessionID: string }>({
    request: async (key, signal, input) => {
      if (!input) throw new Error("Missing board message load input")
      const { scopeKey, sessionID } = input
      deps.ensureScopeState(scopeKey)
      const request = deps.captureResourceRequest(scopeKey, sessionID, "message")
      const revision = deps.beginContextProjection(scopeKey, sessionID)
      // Capture part freshness before the request so deltas arriving while the
      // page is in flight supersede this snapshot (mirrors the session loader).
      const partSnapshotRequest = deps.capturePartSnapshotRequest(scopeKey, sessionID)
      const response = await deps.messagePage({
        scopeRequest: deps.scopeRequest(scopeKey),
        sessionID,
        limit: LIMIT,
      })
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      return { response, request, revision, partSnapshotRequest }
    },
    apply: (key, result) => {
      const page = result.response.data
      if (!page) return "applied"
      const sep = key.indexOf("\n")
      const scopeKey = key.slice(0, sep)
      const sessionID = key.slice(sep + 1)
      const store = deps.ensureScopeState(scopeKey) as unknown[]
      const setStore = store[1] as unknown as SetStoreFunction<BoardScopeStore>
      const current = deps.ensureScopeState(scopeKey)[0] as {
        message?: Record<string, Message[]>
        messageWindow?: Record<string, MessageWindowState<Message>>
      }
      const metadata = current.messageWindow?.[sessionID]
      const plan = deps.plan({
        page,
        current: metadata
          ? {
              messages: current.message?.[sessionID] ?? [],
              mode: metadata.mode,
              pendingLatest: metadata.pendingLatest,
              pendingLatestIds: metadata.pendingLatestIds,
              tailMissingLatest: metadata.tailMissingLatest,
            }
          : undefined,
      })
      const partActions = new Map(
        Object.keys(plan.parts).map((messageID) => [
          messageID,
          deps.partSnapshotAction(scopeKey, sessionID, messageID, result.partSnapshotRequest),
        ]),
      )
      if ([...partActions.values()].some((action) => action === "retry")) return "superseded"
      const accepted = deps.applyResourceResponse(
        scopeKey,
        sessionID,
        "message",
        result.request,
        result.response?.response?.headers,
        () => {
          batch(() => {
            setStore(
              produce((draft: BoardScopeStore) => {
                // Drop part buckets for messages the refreshed page removed,
                // so orphaned parts do not accumulate across board refreshes.
                for (const messageID of plan.droppedIds) delete draft.part[messageID]
              }),
            )
            setStore(
              "message",
              sessionID,
              deps.reconcile(internMessages(plan.window.messages), { key: "id" }) as Message[],
            )
            deps.setLatestContextMessage(scopeKey, sessionID, plan.latestContextMessage, result.revision)
            for (const [messageID, parts] of Object.entries(plan.parts)) {
              if (partActions.get(messageID) === "preserve") continue
              setStore("part", messageID, deps.reconcile(internParts(parts), { key: "id" }) as Part[])
            }
          })
          deps.touchMessageBucket(scopeKey, sessionID)
        },
      )
      return accepted ? "applied" : "superseded"
    },
    onState: (key, state) => deps.onStateChange?.(key, state),
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  })

  const lastReconnectVersion = new Map<string, number>()
  // Keys that left the board; reload them the next time they rejoin instead of
  // trusting a stale phase (their bucket may have been LRU-evicted meanwhile).
  const dirty = new Set<string>()
  let lastPanes = new Set<string>()
  let disposed = false

  function load(scopeKey: string, sessionID: string, options?: { force?: boolean }) {
    if (disposed) return
    const key = `${scopeKey}\n${sessionID}`
    void loader.load(key, {
      force: options?.force,
      input: { scopeKey, sessionID },
    })
  }

  function syncPanes(panes: { scopeKey: string; sessionID: string }[]) {
    if (disposed) return
    const seen = new Set<string>()
    const wanted = new Set<string>()
    for (const pane of panes) {
      const key = `${pane.scopeKey}\n${pane.sessionID}`
      if (seen.has(key)) continue
      seen.add(key)
      wanted.add(key)
      const version = deps.scopeReconnectVersion(pane.scopeKey)
      const last = lastReconnectVersion.get(pane.scopeKey) ?? 0
      if (version > last) {
        lastReconnectVersion.set(pane.scopeKey, version)
        void loader.load(key, { force: true, input: { scopeKey: pane.scopeKey, sessionID: pane.sessionID } })
      } else if (dirty.has(key)) {
        dirty.delete(key)
        load(pane.scopeKey, pane.sessionID)
      } else if (loader.state(key).phase === "idle") {
        // Skip panes that are already loaded/loading; navigation updates must
        // not refetch every visible transcript. Only reconnects force a reload.
        load(pane.scopeKey, pane.sessionID)
      } else if (loader.state(key).phase === "ready" && !deps.hasBucketSnapshot(pane.scopeKey, pane.sessionID)) {
        // The bucket was LRU-evicted while this pane was away (e.g. a session
        // dragged in from the sidebar whose snapshot was evicted): "ready" is
        // stale, so refetch instead of leaving the pane on "loading" forever.
        void loader.load(key, { force: true, input: { scopeKey: pane.scopeKey, sessionID: pane.sessionID } })
      }
    }
    for (const key of lastPanes) {
      if (wanted.has(key)) continue
      const sep = key.indexOf("\n")
      if (sep === -1) continue
      dirty.add(key)
    }
    lastPanes = wanted
  }

  return {
    load,
    state: (scopeKey, sessionID) => {
      const s = loader.state(`${scopeKey}\n${sessionID}`)
      return { phase: s.phase, hasSnapshot: s.hasSnapshot, error: s.error }
    },
    dispose() {
      disposed = true
      loader.dispose()
    },
    syncPanes,
  }
}
