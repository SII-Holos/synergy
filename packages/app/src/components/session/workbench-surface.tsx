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
import type { Component } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useWorkbenchPanels } from "@/context/workbench-panels"
import { computeMaxWorkspaceWidth, WORKSPACE_MIN_WIDTH, WORKSPACE_SESSION_MIN_WIDTH } from "@/context/workspace-layout"
import { SandboxIframe } from "@/plugin/sandbox"
import type {
  WorkbenchPanelContentProps,
  WorkbenchPanelEntry,
  WorkbenchPanelSurface,
  WorkbenchPanelTab,
} from "@/plugin/registries/workbench-panel-registry"
import "./workbench-surface.css"

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
      () => setLoading(false),
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
      <Show when={props.entry.sandbox && props.entry.sandboxUrl}>
        <ErrorBoundary fallback={(error) => <div class="workbench-surface-error">{error.message}</div>}>
          <SandboxIframe src={props.entry.sandboxUrl!} pluginId={props.entry.pluginId} panelId={props.entry.id} />
        </ErrorBoundary>
      </Show>
      <Show when={!props.entry.sandbox}>
        <Show when={comp()} fallback={<div class="workbench-surface-empty">Panel unavailable</div>}>
          {(component) => (
            <Suspense
              fallback={
                <div class="workbench-surface-loading">
                  <Spinner class="size-5" />
                </div>
              }
            >
              {(() => {
                const Loaded = component()
                return (
                  <Loaded
                    pluginId={props.entry.pluginId}
                    panelId={props.entry.id}
                    tab={props.tab}
                    onRequestClose={props.onRequestClose}
                  />
                )
              })()}
            </Suspense>
          )}
        </Show>
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
  const [addOpen, setAddOpen] = createSignal(false)

  const openPanel = (panel: WorkbenchPanelEntry, mode: "launcher" | "add") => {
    setAddOpen(false)
    void workbench.openPanel(panel.id, {
      forceNew: mode === "add" && panel.cardinality === "multi",
      reuseExisting: mode === "launcher",
    })
  }

  createEffect(() => {
    if (!state().opened()) setAddOpen(false)
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
        onCollapse={state().close}
      />
      <aside
        class="workbench-surface-panel"
        style={isSide() ? { width: `${size()}px` } : { height: `${size()}px` }}
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
                    onClick={() => {
                      void workbench.closeTab(tab.id)
                    }}
                  >
                    <Icon name="x" size="small" />
                  </button>
                </div>
              )}
            </For>
            <div class="workbench-surface-tabs-spacer" />
            <div class="workbench-surface-add-wrap">
              <IconButton
                icon="plus"
                variant="ghost"
                aria-label={isSide() ? "Add side panel" : "Add bottom panel"}
                aria-expanded={addOpen()}
                onClick={() => setAddOpen((value) => !value)}
              />
              <Show when={addOpen()}>
                <div class="workbench-surface-add-menu">
                  <For each={panels()}>
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
            <IconButton
              icon="x"
              variant="ghost"
              aria-label={isSide() ? "Close side workspace" : "Close BottomSpace"}
              onClick={state().close}
            />
          </div>
        </Show>
        <div class="workbench-surface-body">
          <Show
            when={activeTab() && activeEntry()}
            fallback={<Launcher surface={props.surface} panels={panels()} onOpen={openPanel} />}
          >
            <WorkbenchPanelContent
              entry={activeEntry()!}
              tab={activeTab()!}
              onRequestClose={() => {
                const tab = activeTab()
                if (!tab) return
                void workbench.closeTab(tab.id)
              }}
            />
          </Show>
        </div>
      </aside>
    </div>
  )
}
