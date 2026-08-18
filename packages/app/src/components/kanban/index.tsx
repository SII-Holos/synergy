import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { reconcile } from "solid-js/store"
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
import type { NavigationContentProps } from "@/plugin/registries/navigation-registry"
import { computeBoardPanes, type BoardPane, type BoardPaneSource } from "./model/pane-selection"
import { createBoardLoader, type BoardLoaderDeps } from "./model/board-loader"
import { KanbanPane, type BoardPaneData, type BoardPaneLoadState } from "./pane/pane"
import { KanbanGrid } from "./layout/grid"
import { KanbanFocus } from "./layout/focus"
import { KanbanWaterfall } from "./layout/waterfall"
import "./kanban.css"

export type KanbanLayout = "grid" | "focus" | "waterfall"

type KanbanPersisted = {
  layout: KanbanLayout
  follow: Record<string, boolean>
  pinned: string[]
}

function defaultKanbanPreferences(): KanbanPersisted {
  return { layout: "grid", follow: {}, pinned: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateKanbanPreferences(value: unknown): KanbanPersisted {
  const base = defaultKanbanPreferences()
  if (!isRecord(value)) return base
  return {
    layout: value.layout === "focus" || value.layout === "waterfall" ? value.layout : "grid",
    follow: isRecord(value.follow) ? (value.follow as Record<string, boolean>) : {},
    pinned: Array.isArray(value.pinned) ? value.pinned.filter((x): x is string => typeof x === "string") : [],
  }
}

const EMPTY_BOARD_PANE_DATA: BoardPaneData = {
  message: {},
  messageWindow: {},
  part: {},
  session_diff: {},
  session_status: {},
  cortex: [],
  session: [],
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
      const child = globalSync.peekScopeState(scopeKey)?.[0]
      const status = child?.session_status?.[entry.id]
      const waiting = !!child?.permission?.[entry.id]?.length || !!child?.question?.[entry.id]?.length
      const running = status?.type === "busy" || status?.type === "retry"
      result.push({ scopeKey, entry, running, waiting })
    }
    return result
  })

  const panes = createMemo(() => computeBoardPanes({ pinned: store.pinned, sources: sources() }))

  // --- Loader (cross-scope message page + eviction protection) ---
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
    protectMessageBucket: (scopeKey, sessionID) => globalSync.protectMessageBucket(scopeKey, sessionID),
    unprotectMessageBucket: (scopeKey, sessionID) => globalSync.unprotectMessageBucket(scopeKey, sessionID),
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

  // Load / protect live panes; reload on reconnect version bump. Unavailable
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
    for (const pane of panes()) {
      if (pane.kind === "live") boardLoader.unprotect(pane.scopeKey, pane.sessionID)
    }
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

  const renderPane = (pane: BoardPane, variant: "focus" | "rail" | "waterfall" | "default" = "default") => {
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
        onRemove={pane.kind === "unavailable" ? () => unpinPane(pane) : undefined}
        compact={variant === "rail"}
        timeAlign={variant === "waterfall"}
        loadState={loadStateFor(pane)}
        onRetry={retryPane(pane)}
      />
    )
  }

  const unpinnedSources = createMemo(() => {
    const pinned = new Set(store.pinned)
    return sources().filter((source) => !pinned.has(`${source.scopeKey}\n${source.entry.id}`))
  })

  return (
    <div data-component="kanban-panel" class="kanban-panel">
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
          <button
            class="kanban-layout-btn"
            data-active={layoutMode() === "waterfall" || undefined}
            onClick={() => setLayoutMode("waterfall")}
          >
            {_(kanbanPage.layoutWaterfall)}
          </button>
        </div>
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
            <SwitchLayout mode={layoutMode()} panes={panes()} render={renderPane} />
          </Show>
        </Show>
      </div>
    </div>
  )
}

function SwitchLayout(props: {
  mode: KanbanLayout
  panes: BoardPane[]
  render: (pane: BoardPane, variant?: "focus" | "rail" | "waterfall") => ReturnType<typeof KanbanPanel> | null
}) {
  const panes = () => props.panes
  const render = props.render
  return (
    <>
      <Show when={props.mode === "grid"} fallback={<></>}>
        <KanbanGrid panes={panes()} renderPane={(pane) => render(pane)} />
      </Show>
      <Show when={props.mode === "focus"} fallback={<></>}>
        <KanbanFocus panes={panes()} renderPane={(pane, variant) => render(pane, variant) ?? <></>} />
      </Show>
      <Show when={props.mode === "waterfall"} fallback={<></>}>
        <KanbanWaterfall panes={panes()} renderPane={(pane) => render(pane, "waterfall")} />
      </Show>
    </>
  )
}
