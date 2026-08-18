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
import { kanbanPage } from "@/locales/messages"
import type { NavigationContentProps } from "@/plugin/registries/navigation-registry"
import { computeBoardPanes, type BoardPane, type BoardPaneSource } from "./model/pane-selection"
import { createBoardLoader } from "./model/board-loader"
import { KanbanPane, type BoardPaneData } from "./pane/pane"
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
  const boardLoader = createBoardLoader({
    ensureScopeState: (scopeKey) => globalSync.ensureScopeState(scopeKey),
    captureResourceRequest: (scopeKey, sessionID, resource) =>
      globalSync.captureResourceRequest(scopeKey, sessionID, resource),
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
  })

  // Load / protect panes; reload on reconnect version bump.
  createEffect(() => {
    const current = panes()
    boardLoader.syncPanes(current.map((pane) => ({ scopeKey: pane.scopeKey, sessionID: pane.sessionID })))
  })

  onCleanup(() => {
    for (const pane of panes()) boardLoader.unprotect(pane.scopeKey, pane.sessionID)
    boardLoader.dispose()
  })

  const followFor = (pane: BoardPane) => () => store.follow[pane.key] !== false
  const toggleFollow = (pane: BoardPane) =>
    setStore("follow", pane.key, (current: boolean | undefined) => current === false)

  const pinPane = (pane: BoardPane) => {
    if (store.pinned.includes(pane.key)) return
    setStore("pinned", (pinned) => [...pinned, pane.key])
  }
  const unpinPane = (pane: BoardPane) => setStore("pinned", (pinned) => pinned.filter((key) => key !== pane.key))

  const openSession = (pane: BoardPane) => {
    if (pane.kind !== "live" || !pane.entry) return
    const dir = pane.entry.scopeType === "home" ? HOME_SCOPE_KEY : pane.entry.scopeID
    navigate(`/${base64Encode(dir)}/session/${pane.sessionID}`)
  }

  const renderPane = (pane: BoardPane, variant: "focus" | "rail" | "default" = "default") => {
    const child = globalSync.peekScopeState(pane.scopeKey)?.[0] as BoardPaneData | undefined
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
        onPinToggle={pane.pinned ? () => unpinPane(pane) : () => pinPane(pane)}
        onRemove={pane.kind === "unavailable" ? () => unpinPane(pane) : undefined}
        compact={variant === "rail"}
      />
    )
  }

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
        <Show when={sources().some((source) => !store.pinned.includes(`${source.scopeKey}\n${source.entry.id}`))}>
          <button
            class="kanban-add-btn"
            onClick={() => {
              const first = sources().find((source) => !store.pinned.includes(`${source.scopeKey}\n${source.entry.id}`))
              if (first)
                pinPane({
                  key: `${first.scopeKey}\n${first.entry.id}`,
                  scopeKey: first.scopeKey,
                  sessionID: first.entry.id,
                  kind: "live",
                  pinned: false,
                  entry: first.entry,
                })
            }}
          >
            {_(kanbanPage.addPane)}
          </button>
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
  render: (pane: BoardPane, variant?: "focus" | "rail") => ReturnType<typeof KanbanPanel> | null
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
        <KanbanWaterfall panes={panes()} renderPane={(pane) => render(pane)} />
      </Show>
    </>
  )
}
