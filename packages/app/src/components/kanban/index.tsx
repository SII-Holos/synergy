import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { createSynergyClient, type WorkflowSetInput } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout, type NavEntry } from "@/context/layout"
import { HOME_SCOPE_KEY, isHomeScope } from "@/utils/scope"
import { planMessagePageApply } from "@/context/session-message-page"
import { scopeKeyForNavEntry } from "@/components/sidebar/session-visual-state"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { kanbanPage } from "@/locales/messages"
import { resolveActivityDisplay } from "@ericsanchezok/synergy-ui/session-turn-activity"
import type { ControlProfileId } from "@/context/input"
import type { NavigationContentProps } from "@/plugin/registries/navigation-registry"
import { computeBoardPanes, BOARD_PANE_CAP, type BoardPane, type BoardPaneSource } from "./model/pane-selection"
import { createBoardLoader, type BoardLoaderDeps } from "./model/board-loader"
import { KanbanPane, type BoardPaneData, type BoardPaneLoadState } from "./pane/pane"
import type { BoardWorkflowKind } from "./pane/composer"
import { KanbanGrid } from "./layout/grid"
import { KanbanFocus } from "./layout/focus"
import "./kanban.css"
import { parseSessionDragPayload, SESSION_DRAG_MIME } from "@/utils/session-drag"

import {
  defaultKanbanPreferences,
  migrateKanbanPreferences,
  type KanbanLayout,
  type KanbanPersisted,
} from "./model/preferences"

const EMPTY_BOARD_PANE_DATA: BoardPaneData = {
  message: {},
  messageWindow: {},
  part: {},
  session_diff: {},
  session_status: {},
  cortex: [],
  session: [],
  agent: [],
}

export function KanbanPanel() {
  const { _ } = useLingui()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()

  const [store, setStore, , ready] = persisted(
    { ...Persist.global("kanban", ["kanban.v1"]), migrate: migrateKanbanPreferences },
    createStore<KanbanPersisted>(defaultKanbanPreferences()),
  )

  const layoutMode = () => store.layout
  const setLayoutMode = (mode: KanbanLayout) => setStore("layout", mode)

  // Shared display settings: the board renders turns exactly like the session
  // page (activity display mode + compact reasoning from the global config).
  const activityDisplay = createMemo(() => resolveActivityDisplay(globalSync.data.config.activityDisplay))
  const compactReasoning = () => globalSync.data.config.compactReasoning === true

  // Pane capacity follows the active layout: grid shows exactly cols × rows,
  // focus keeps the fixed board cap (main pane + scrollable rail).
  const paneCap = () => (layoutMode() === "grid" ? store.gridCols * store.gridRows : BOARD_PANE_CAP)

  // --- Collect every visible top-level session across scopes ---
  const navEntries = createMemo(() => {
    const list: NavEntry[] = []
    const seen = new Set<string>()
    const push = (entry: NavEntry) => {
      if (entry.parentID) return
      const key = `${entry.scopeID}:${entry.id}`
      if (seen.has(key)) return
      seen.add(key)
      list.push(entry)
    }
    for (const entry of layout.nav.recentEntries()) push(entry)
    for (const category of ["home", "channel", "background"] as const) {
      for (const entry of layout.nav.rootNavEntries(category)) push(entry)
    }
    for (const scope of globalSync.data.scope) {
      const localScope = { ...scope, expanded: false }
      for (const entry of layout.nav.projectNavEntries(localScope)) push(entry)
    }
    return list
  })

  const sources = createMemo<BoardPaneSource[]>(() => {
    const result: BoardPaneSource[] = []
    for (const entry of navEntries()) {
      const scopeKey = scopeKeyForNavEntry(entry, globalSync.data.scope)
      if (!scopeKey) continue
      result.push({ scopeKey, entry })
    }
    // Mirror the sidebar recent order: most recently active first.
    return result.toSorted(
      (a, b) => b.entry.lastActivityAt - a.entry.lastActivityAt || a.entry.id.localeCompare(b.entry.id),
    )
  })

  const panes = createMemo(() => computeBoardPanes({ pinned: store.pinned, sources: sources(), cap: paneCap() }))

  // --- Loader (cross-scope message page; panes rejoin the LRU on re-entry) ---
  const [loadStates, setLoadStates] = createStore<Record<string, BoardPaneLoadState>>({})
  const boardLoader = createBoardLoader({
    ensureScopeState: (scopeKey) => globalSync.ensureScopeState(scopeKey),
    captureResourceRequest: (scopeKey, sessionID, resource) =>
      globalSync.captureResourceRequest(scopeKey, sessionID, resource),
    capturePartSnapshotRequest: (scopeKey, sessionID) => globalSync.capturePartSnapshotRequest(scopeKey, sessionID),
    partSnapshotAction: (scopeKey, sessionID, messageID, request) =>
      globalSync.partSnapshotAction(scopeKey, sessionID, messageID, request),
    beginContextProjection: (scopeKey, sessionID) => globalSync.beginContextProjection(scopeKey, sessionID),
    applyResourceResponse: (scopeKey, sessionID, resource, request, headers, apply) =>
      globalSync.applyResourceResponse(scopeKey, sessionID, resource, request, headers, apply),
    setLatestContextMessage: (scopeKey, sessionID, message, revision) =>
      globalSync.setLatestContextMessage(scopeKey, sessionID, message, revision),
    touchMessageBucket: (scopeKey, sessionID) => globalSync.touchMessageBucket(scopeKey, sessionID),
    scopeRequest: (scopeKey) =>
      (isHomeScope(scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: scopeKey }) as Record<string, string>,
    scopeReconnectVersion: (scopeKey) => globalSync.scopeReconnectVersion(scopeKey),
    messagePage: (input) => {
      const client = createSynergyClient({ baseUrl: globalSDK.url, ...input.scopeRequest, throwOnError: true })
      return client.session.messagePage({ sessionID: input.sessionID, limit: input.limit })
    },
    plan: planMessagePageApply,
    reconcile: (value, options) => reconcile(value, options) as never,
    onStateChange: (key, state) =>
      setLoadStates(key, { phase: state.phase, hasSnapshot: state.hasSnapshot, error: state.error }),
  } satisfies BoardLoaderDeps)

  // Load live panes; reload on reconnect version bump. Unavailable
  // placeholders never reach the loader (their sessions no longer exist).
  createEffect(() => {
    const current = panes()
    boardLoader.syncPanes(
      current
        .filter((pane) => pane.kind === "live")
        .map((pane) => ({ scopeKey: pane.scopeKey, sessionID: pane.sessionID })),
    )
  })

  onCleanup(() => {
    boardLoader.dispose()
  })

  const followFor = (pane: BoardPane) => () => store.follow[pane.key] !== false
  const toggleFollow = (pane: BoardPane) =>
    setStore("follow", pane.key, (current: boolean | undefined) => current === false)

  const pinKey = (key: string) => {
    if (store.pinned.includes(key)) return
    setStore("pinned", (pinned) => [...pinned, key])
  }
  const pinSource = (source: BoardPaneSource) => pinKey(`${source.scopeKey}\n${source.entry.id}`)
  const unpinPane = (pane: BoardPane) => setStore("pinned", (pinned) => pinned.filter((key) => key !== pane.key))

  const openSession = (pane: BoardPane) => {
    if (pane.kind !== "live" || !pane.entry) return
    // pane.scopeKey is the worktree directory (or HOME_SCOPE_KEY) resolved by
    // scopeKeyForNavEntry, matching the sidebar/mobile drawer route shape.
    navigate(`/${base64Encode(pane.scopeKey)}/session/${pane.sessionID}`)
  }

  const loadStateFor = (pane: BoardPane) => () =>
    pane.kind === "live" ? loadStates[`${pane.scopeKey}\n${pane.sessionID}`] : undefined
  const retryPane = (pane: BoardPane) => () => {
    if (pane.kind !== "live") return
    boardLoader.load(pane.scopeKey, pane.sessionID, { force: true })
  }
  const clientFor = (pane: BoardPane) =>
    createSynergyClient({
      baseUrl: globalSDK.url,
      ...(isHomeScope(pane.scopeKey) ? { scopeID: HOME_SCOPE_KEY } : { directory: pane.scopeKey }),
      throwOnError: true,
    })

  const sendToPane = (pane: BoardPane) => async (text: string, options?: { agent?: string }) => {
    if (pane.kind !== "live") return
    // Session.input accepts a plain text part; agent/model fall back to the
    // session's last used values server-side. The composer may override the
    // agent explicitly (matching the session page's agent selector).
    await clientFor(pane).session.input({
      sessionID: pane.sessionID,
      parts: [{ type: "text", text }],
      ...(options?.agent ? { agent: options.agent } : {}),
    })
  }
  const updateProfileFor = (pane: BoardPane) => async (profile: ControlProfileId) => {
    if (pane.kind !== "live") return
    await clientFor(pane).session.update({
      sessionID: pane.sessionID,
      controlProfile: profile,
      ...(profile === "full_access" ? { resolvePendingPermissions: true } : {}),
    })
  }

  const setWorkflowFor = (pane: BoardPane) => async (kind: BoardWorkflowKind) => {
    if (pane.kind !== "live") return
    const workflowSetInput: WorkflowSetInput = kind === "lattice" ? { kind, mode: "auto" } : { kind }
    await clientFor(pane).workflow.session.set({
      id: pane.sessionID,
      workflowSetInput,
    })
  }

  const renderPane = (pane: BoardPane, variant: "focus" | "rail" | "default" = "default") => {
    // Unavailable panes render their placeholder independently of Scope data:
    // their session is gone, so no store exists and nothing should be loaded.
    const child =
      pane.kind === "unavailable"
        ? EMPTY_BOARD_PANE_DATA
        : (globalSync.peekScopeState(pane.scopeKey)?.[0] as BoardPaneData | undefined)
    if (!child) return null
    return (
      <KanbanPane
        pane={pane}
        data={child}
        serverUrl={globalSDK.url}
        directory={pane.scopeKey}
        follow={followFor(pane)}
        onToggleFollow={() => toggleFollow(pane)}
        onOpen={() => openSession(pane)}
        onPinToggle={pane.pinned ? () => unpinPane(pane) : () => pinKey(pane.key)}
        compact={variant === "rail"}
        activityDisplay={activityDisplay}
        compactReasoning={compactReasoning}
        loadState={loadStateFor(pane)}
        onRetry={retryPane(pane)}
        onSend={sendToPane(pane)}
        onUpdateProfile={updateProfileFor(pane)}
        onSetWorkflow={setWorkflowFor(pane)}
      />
    )
  }

  const unpinnedSources = createMemo(() => {
    const pinned = new Set(store.pinned)

    return sources().filter((source) => !pinned.has(`${source.scopeKey}\n${source.entry.id}`))
  })

  // --- Drag-and-drop pin: sessions dragged from the sidebar land here ---
  const [dragActive, setDragActive] = createSignal(false)
  let dragDepth = 0
  const handleDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes(SESSION_DRAG_MIME)) return
    dragDepth += 1
    setDragActive(true)
  }
  const handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes(SESSION_DRAG_MIME)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  }
  const handleDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragActive(false)
  }
  const handleDrop = (event: DragEvent) => {
    dragDepth = 0
    setDragActive(false)
    const payload = event.dataTransfer?.getData(SESSION_DRAG_MIME)
    if (!payload) return
    const session = parseSessionDragPayload(payload)
    if (!session) return
    event.preventDefault()
    pinKey(`${session.scopeKey}\n${session.sessionID}`)
  }

  return (
    <div
      data-component="kanban-panel"
      class="kanban-panel"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-dragging={dragActive() || undefined}
    >
      <div class="kanban-toolbar">
        <span class="kanban-toolbar-title">{_(kanbanPage.title)}</span>
        <div class="kanban-layout-switcher" role="group" aria-label={_(kanbanPage.ariaLayout)}>
          <button
            class="kanban-layout-btn"
            data-active={layoutMode() === "grid" || undefined}
            onClick={() => setLayoutMode("grid")}
          >
            {_(kanbanPage.layoutGrid)}
          </button>
          <button
            class="kanban-layout-btn"
            data-active={layoutMode() === "focus" || undefined}
            onClick={() => setLayoutMode("focus")}
          >
            {_(kanbanPage.layoutFocus)}
          </button>
        </div>
        <Show when={layoutMode() === "grid"}>
          <div class="kanban-grid-config" role="group" aria-label={_(kanbanPage.gridLayoutLabel)}>
            <label class="kanban-grid-config-field">
              <span>{_(kanbanPage.gridColumns)}</span>
              <select
                value={store.gridCols}
                onChange={(event) => setStore("gridCols", Number(event.currentTarget.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
            <label class="kanban-grid-config-field">
              <span>{_(kanbanPage.gridRows)}</span>
              <select
                value={store.gridRows}
                onChange={(event) => setStore("gridRows", Number(event.currentTarget.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
          </div>
        </Show>
        <Show when={unpinnedSources().length > 0}>
          <Popover
            trigger={
              <button class="kanban-add-btn">
                <span>{_(kanbanPage.addPane)}</span>
              </button>
            }
            title={_(kanbanPage.addPane)}
            description={_(kanbanPage.addPaneHint)}
          >
            <div class="kanban-add-menu" role="listbox" aria-label={_(kanbanPage.addPane)}>
              <For each={unpinnedSources()}>
                {(source) => (
                  <button class="kanban-add-item" role="option" onClick={() => pinSource(source)}>
                    <span class="kanban-add-item-title">{source.entry.title}</span>
                    <span class="kanban-add-item-scope">
                      {source.entry.scopeType === "home" ? "HOME" : source.entry.scopeID}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Popover>
        </Show>
      </div>
      <div class="kanban-body">
        <Show
          when={panes().length > 0}
          fallback={
            <div class="kanban-empty">
              <p>{_(kanbanPage.empty)}</p>
              <p class="kanban-empty-hint">{_(kanbanPage.emptyHint)}</p>
            </div>
          }
        >
          <Show when={ready()}>
            <SwitchLayout
              mode={layoutMode()}
              panes={panes()}
              render={renderPane}
              gridCols={store.gridCols}
              gridRows={store.gridRows}
            />
          </Show>
        </Show>
      </div>
    </div>
  )
}

function SwitchLayout(props: {
  mode: KanbanLayout
  panes: BoardPane[]
  render: (pane: BoardPane, variant?: "focus" | "rail") => ReturnType<typeof KanbanPanel> | null
  gridCols: number
  gridRows: number
}) {
  const panes = () => props.panes
  const render = props.render
  return (
    <>
      <Show when={props.mode === "grid"} fallback={<></>}>
        <KanbanGrid panes={panes()} renderPane={(pane) => render(pane)} cols={props.gridCols} rows={props.gridRows} />
      </Show>
      <Show when={props.mode === "focus"} fallback={<></>}>
        <KanbanFocus panes={panes()} renderPane={(pane, variant) => render(pane, variant) ?? <></>} />
      </Show>
    </>
  )
}
