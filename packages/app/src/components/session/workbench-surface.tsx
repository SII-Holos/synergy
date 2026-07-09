import {
  ErrorBoundary,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { Component } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useWorkbenchPanels } from "@/context/workbench-panels"
import { computeMaxWorkspaceWidth, WORKSPACE_MIN_WIDTH, WORKSPACE_SESSION_MIN_WIDTH } from "@/context/workspace-layout"
import type {
  WorkbenchPanelContentProps,
  WorkbenchPanelEntry,
  WorkbenchPanelSurface,
  WorkbenchPanelTab,
} from "@/plugin/registries/workbench-panel-registry"
import "./workbench-surface.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

function WorkbenchPanelContent(props: {
  entry: WorkbenchPanelEntry
  tab: WorkbenchPanelTab
  onRequestClose: () => void
}) {
  const [comp, setComp] = createSignal<Component<WorkbenchPanelContentProps> | null>(props.entry.component ?? null)
  const [loading, setLoading] = createSignal(!props.entry.component && !!props.entry.loader)

  onMount(() => {
    if (!props.entry.loader) return
    props.entry.loader().then(
      (mod) => {
        setComp(() => mod.default)
        setLoading(false)
      },
      () => {
        setLoading(false)
      },
    )
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="workbench-surface-loading">
          <Spinner class="size-5" />
        </div>
      }
    >
      <Show when={comp()} fallback={<div class="workbench-surface-empty">Panel unavailable</div>}>
        {(component) => (
          <ErrorBoundary fallback={(error) => <div class="workbench-surface-error">{error.message}</div>}>
            <Suspense
              fallback={
                <div class="workbench-surface-loading">
                  <Spinner class="size-5" />
                </div>
              }
            >
              {(() => {
                const Loaded = component()
                return <Loaded pluginId={props.entry.pluginId ?? ""} panelId={props.entry.id} tab={props.tab} />
              })()}
            </Suspense>
          </ErrorBoundary>
        )}
      </Show>
    </Show>
  )
}

function Launcher(props: {
  surface: WorkbenchPanelSurface
  panels: WorkbenchPanelEntry[]
  onOpen: (panel: WorkbenchPanelEntry, mode: "launcher" | "add") => void
}) {
  return (
    <div class="workbench-surface-launcher">
      <For
        each={props.panels}
        fallback={
          <div class="workbench-surface-empty">
            {props.surface === "side" ? "No side panels available" : "No bottom panels available"}
          </div>
        }
      >
        {(panel) => (
          <button type="button" class="workbench-surface-launcher-row" onClick={() => props.onOpen(panel, "launcher")}>
            <span class="workbench-surface-launcher-icon">
              <Icon name={panel.icon as IconName} size="small" />
            </span>
            <span class="workbench-surface-launcher-copy">
              <span class="workbench-surface-launcher-title">{panel.label}</span>
              <span class="workbench-surface-launcher-detail">
                {panel.cardinality === "multi" ? "Open a new tab" : "Open panel"}
              </span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

export function WorkbenchSurface(props: { surface: WorkbenchPanelSurface }) {
  const workbench = useWorkbenchPanels()
  const state = createMemo(() => workbench.surface(props.surface))
  const panels = createMemo(() => workbench.panels(props.surface))
  const activeTab = createMemo(() => state().activeTab())
  const activeEntry = createMemo(() => workbench.panelForTab(activeTab()))
  const activePanel = createMemo(() => {
    const tab = activeTab()
    const entry = activeEntry()
    if (!tab || !entry) return undefined
    return { tab, entry }
  })
  const addablePanels = createMemo(() => {
    const openPanelIds = new Set(
      state()
        .tabs()
        .map((tab) => tab.panelId),
    )
    return panels().filter((panel) => panel.cardinality === "multi" || !openPanelIds.has(panel.id))
  })
  const [local, setLocal] = createStore({
    addOpen: false,
    resizing: false,
  })

  const openPanel = (panel: WorkbenchPanelEntry, mode: "launcher" | "add") => {
    setLocal("addOpen", false)
    void workbench.openPanel(panel.id, {
      forceNew: mode === "add" && panel.cardinality === "multi",
      reuseExisting: mode === "launcher",
    })
  }

  createEffect(() => {
    if (!state().opened()) setLocal("addOpen", false)
  })

  createEffect(() => {
    if (addablePanels().length === 0) setLocal("addOpen", false)
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (!state().opened()) return
      state().close()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const size = () => state().size()
  const isSide = () => props.surface === "side"
  const maxSideWidth = () =>
    computeMaxWorkspaceWidth(window.innerWidth, { sessionMinWidth: WORKSPACE_SESSION_MIN_WIDTH })
  const maxBottomHeight = () => window.innerHeight * 0.6

  const rootStyle = () =>
    isSide()
      ? { width: state().opened() ? `${size()}px` : "0px" }
      : { height: state().opened() ? `${size()}px` : "0px" }

  return (
    <div
      class="workbench-surface"
      classList={{
        "workbench-surface--side": isSide(),
        "workbench-surface--bottom": !isSide(),
        "workbench-surface--open": state().opened(),
        "workbench-surface--resizing": local.resizing,
      }}
      style={rootStyle()}
    >
      <ResizeHandle
        direction={isSide() ? "horizontal" : "vertical"}
        edge={isSide() ? "start" : undefined}
        size={size()}
        min={isSide() ? WORKSPACE_MIN_WIDTH : 120}
        max={isSide() ? maxSideWidth() : maxBottomHeight()}
        collapseThreshold={isSide() ? 200 : 50}
        onResize={state().setSize}
        onResizeStart={() => setLocal("resizing", true)}
        onResizeEnd={() => setLocal("resizing", false)}
        onCollapse={state().close}
      />
      <aside
        class="workbench-surface-panel"
        role="complementary"
        aria-label={isSide() ? "Side workspace" : "BottomSpace"}
      >
        <Show when={state().tabs().length > 0}>
          <div class="workbench-surface-tabs">
            <For each={state().tabs()}>
              {(tab) => (
                <div
                  class="workbench-surface-tab"
                  classList={{ "workbench-surface-tab--active": state().active() === tab.id }}
                >
                  <button type="button" class="workbench-surface-tab-main" onClick={() => state().setActive(tab.id)}>
                    <Show when={workbench.panelForTab(tab)}>
                      {(entry) => <Icon name={entry().icon as IconName} size="small" />}
                    </Show>
                    <span>{workbench.panelTitle(tab)}</span>
                  </button>
                  <button
                    type="button"
                    class="workbench-surface-tab-close"
                    aria-label={`Close ${workbench.panelTitle(tab)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      void workbench.closeTab(tab.id)
                    }}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" />
                  </button>
                </div>
              )}
            </For>
            <Show when={addablePanels().length > 0}>
              <div class="workbench-surface-add-wrap">
                <IconButton
                  icon={getSemanticIcon("action.add")}
                  variant="ghost"
                  aria-label={isSide() ? "Add side panel" : "Add bottom panel"}
                  aria-expanded={local.addOpen}
                  onClick={() => setLocal("addOpen", (value) => !value)}
                />
                <Show when={local.addOpen}>
                  <div class="workbench-surface-add-menu">
                    <For each={addablePanels()}>
                      {(panel) => (
                        <button type="button" class="workbench-surface-add-row" onClick={() => openPanel(panel, "add")}>
                          <Icon name={panel.icon as IconName} size="small" />
                          <span>{panel.label}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        <div class="workbench-surface-body">
          <Show
            when={activePanel()}
            keyed
            fallback={<Launcher surface={props.surface} panels={addablePanels()} onOpen={openPanel} />}
          >
            {(panel) => (
              <WorkbenchPanelContent
                entry={panel.entry}
                tab={panel.tab}
                onRequestClose={() => {
                  void workbench.closeTab(panel.tab.id)
                }}
              />
            )}
          </Show>
        </div>
      </aside>
    </div>
  )
}
