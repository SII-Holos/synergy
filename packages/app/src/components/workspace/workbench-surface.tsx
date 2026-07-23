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
import { Trans, useLingui } from "@lingui/solid"
import type { Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { ResizeHandle } from "@ericsanchezok/synergy-ui/resize-handle"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useWorkbenchPanels } from "@/context/workbench"
import { resolveWorkbenchEscapeAction } from "@/context/workbench/panel-model"
import { isWorkbenchPanelLaunchable } from "@/context/workbench/panel-model"
import { computeMaxWorkspaceWidth, WORKSPACE_MIN_WIDTH, WORKSPACE_SESSION_MIN_WIDTH } from "@/context/layout/workspace"
import type {
  WorkbenchPanelContentProps,
  WorkbenchPanelEntry,
  WorkbenchPanelSurface,
  WorkbenchPanelTab,
} from "@/plugin/registries/workbench-panel-registry"
import "./workbench-surface.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { workspace as W } from "@/locales/messages"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"

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
      <Show
        when={comp()}
        fallback={
          <div class="workbench-surface-empty">
            <Trans id={W.panelUnavailable.id} message={W.panelUnavailable.message} />
          </div>
        }
      >
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
                return (
                  <Loaded
                    pluginId={props.entry.pluginId ?? ""}
                    panelId={props.entry.id}
                    tab={props.tab}
                    onRequestClose={props.onRequestClose}
                  />
                )
              })()}
            </Suspense>
          </ErrorBoundary>
        )}
      </Show>
    </Show>
  )
}

function WorkbenchSortableTab(props: {
  tab: WorkbenchPanelTab
  tabs: WorkbenchPanelTab[]
  active: boolean
  title: string
  entry?: WorkbenchPanelEntry
  onActivate: () => void
  onClose: () => void
  onFocusIndex: (index: number) => void
}) {
  const lingui = useLingui()
  const sortable = createSortable(props.tab.id)
  let main!: HTMLButtonElement
  createEffect(() => {
    if (!props.active) return
    main?.scrollIntoView({ block: "nearest", inline: "nearest" })
  })
  const currentIndex = () => props.tabs.findIndex((tab) => tab.id === props.tab.id)
  return (
    <div
      use:sortable
      class="workbench-surface-tab"
      classList={{
        "workbench-surface-tab--active": props.active,
        "workbench-surface-tab--dragging": sortable.isActiveDraggable,
      }}
      title={props.tab.resourceId ?? props.title}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        props.onClose()
      }}
    >
      <button
        ref={main}
        type="button"
        role="tab"
        class="workbench-surface-tab-main"
        aria-selected={props.active}
        aria-label={props.tab.resourceId ?? props.title}
        tabIndex={props.active ? 0 : -1}
        onClick={props.onActivate}
        onKeyDown={(event) => {
          const index = currentIndex()
          if (event.key === "ArrowLeft") props.onFocusIndex(index - 1)
          else if (event.key === "ArrowRight") props.onFocusIndex(index + 1)
          else if (event.key === "Home") props.onFocusIndex(0)
          else if (event.key === "End") props.onFocusIndex(props.tabs.length - 1)
          else if (event.key === "Enter" || event.key === " ") props.onActivate()
          else if (event.key === "Delete") props.onClose()
          else return
          event.preventDefault()
        }}
      >
        <Show when={props.entry}>
          {(entry) => entry().tabIcon?.(props.tab) ?? <Icon name={entry().icon as IconName} size="small" />}
        </Show>
        <span>{props.title}</span>
      </button>
      <button
        type="button"
        class="workbench-surface-tab-close"
        aria-label={lingui._({
          id: W.closeTab.id,
          message: W.closeTab.message,
          values: { title: props.tab.resourceId ?? props.title },
        })}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose()
        }}
      >
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
    </div>
  )
}
function Launcher(props: {
  surface: WorkbenchPanelSurface
  panels: WorkbenchPanelEntry[]
  onOpen: (panel: WorkbenchPanelEntry, mode: "launcher" | "add") => void
}) {
  const lingui = useLingui()
  return (
    <div class="workbench-surface-launcher">
      <For
        each={props.panels}
        fallback={
          <div class="workbench-surface-empty">
            {props.surface === "side"
              ? lingui._({ id: W.noSidePanels.id, message: W.noSidePanels.message })
              : lingui._({ id: W.noBottomPanels.id, message: W.noBottomPanels.message })}
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
                {panel.cardinality === "multi"
                  ? lingui._({ id: W.openNewTab.id, message: W.openNewTab.message })
                  : lingui._({ id: W.openPanel.id, message: W.openPanel.message })}
              </span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

export function WorkbenchSurface(props: { surface: WorkbenchPanelSurface }) {
  const lingui = useLingui()
  const dialog = useDialog()
  const workbench = useWorkbenchPanels()
  const state = createMemo(() => workbench.surface(props.surface))
  const panels = createMemo(() => workbench.panels(props.surface).filter(isWorkbenchPanelLaunchable))
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
  let tabRun: HTMLDivElement | undefined

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
      const action = resolveWorkbenchEscapeAction({
        key: event.key,
        opened: state().opened(),
        addOpen: local.addOpen,
        dialogActive: Boolean(dialog.active),
      })
      if (action === "none") return
      event.preventDefault()
      event.stopPropagation()
      if (action === "close-add-menu") {
        setLocal("addOpen", false)
        return
      }
      state().close()
    }
    document.addEventListener("keydown", onKey, { capture: true })
    onCleanup(() => document.removeEventListener("keydown", onKey, { capture: true }))
  })

  const size = () => state().size()
  const isSide = () => props.surface === "side"
  const maxSideWidth = () =>
    Math.max(
      WORKSPACE_MIN_WIDTH,
      computeMaxWorkspaceWidth(window.innerWidth, { sessionMinWidth: WORKSPACE_SESSION_MIN_WIDTH }),
    )
  const maxBottomHeight = () => window.innerHeight * 0.6

  const rootStyle = () =>
    isSide()
      ? { width: state().opened() ? `${size()}px` : "0px" }
      : { height: state().opened() ? `${size()}px` : "0px" }

  const focusTab = (index: number) => {
    const tabs = state().tabs()
    if (tabs.length === 0) return
    const target = Math.max(0, Math.min(tabs.length - 1, index))
    tabRun?.querySelectorAll<HTMLButtonElement>(".workbench-surface-tab-main")[target]?.focus()
  }

  const handleDragEnd = (event: DragEvent) => {
    const draggable = event.draggable?.id
    const droppable = event.droppable?.id
    if (!draggable || !droppable || draggable === droppable) return
    const index = state()
      .tabs()
      .findIndex((tab) => tab.id === droppable)
    if (index >= 0) workbench.moveTab(props.surface, String(draggable), index)
  }

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
        aria-label={
          isSide()
            ? lingui._({ id: W.sideWorkspace.id, message: W.sideWorkspace.message })
            : lingui._({ id: W.bottomWorkspace.id, message: W.bottomWorkspace.message })
        }
      >
        <Show when={state().tabs().length > 0}>
          <div class="workbench-surface-tabs">
            <DragDropProvider onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
              <DragDropSensors />
              <ConstrainDragYAxis />
              <div
                ref={tabRun}
                class="workbench-surface-tab-run"
                role="tablist"
                aria-label={
                  isSide()
                    ? lingui._({ id: W.sideTabs.id, message: W.sideTabs.message })
                    : lingui._({ id: W.bottomTabs.id, message: W.bottomTabs.message })
                }
                onWheel={(event) => {
                  if (!tabRun || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
                  tabRun.scrollLeft += event.deltaY
                  event.preventDefault()
                }}
              >
                <SortableProvider
                  ids={state()
                    .tabs()
                    .map((tab) => tab.id)}
                >
                  <For each={state().tabs()}>
                    {(tab) => (
                      <WorkbenchSortableTab
                        tab={tab}
                        tabs={state().tabs()}
                        active={state().active() === tab.id}
                        title={workbench.panelTitle(tab)}
                        entry={workbench.panelForTab(tab)}
                        onActivate={() => state().setActive(tab.id)}
                        onClose={() => void workbench.closeTab(tab.id)}
                        onFocusIndex={focusTab}
                      />
                    )}
                  </For>
                </SortableProvider>
                <Show when={addablePanels().length > 0}>
                  <div class="workbench-surface-add-wrap">
                    <Popover
                      open={local.addOpen}
                      onOpenChange={(open) => setLocal("addOpen", open)}
                      placement="bottom-start"
                      gutter={6}
                      class="workbench-surface-add-menu"
                      trigger={
                        <IconButton
                          icon={getSemanticIcon("action.add")}
                          variant="ghost"
                          aria-label={
                            isSide()
                              ? lingui._({ id: W.addSidePanel.id, message: W.addSidePanel.message })
                              : lingui._({ id: W.addBottomPanel.id, message: W.addBottomPanel.message })
                          }
                          aria-haspopup="menu"
                          aria-expanded={local.addOpen}
                        />
                      }
                    >
                      <div class="workbench-surface-add-list" role="menu">
                        <For each={addablePanels()}>
                          {(panel) => (
                            <button
                              type="button"
                              class="workbench-surface-add-row"
                              role="menuitem"
                              onClick={() => openPanel(panel, "add")}
                            >
                              <Icon name={panel.icon as IconName} size="small" />
                              <span>{panel.label}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Popover>
                  </div>
                </Show>
              </div>
            </DragDropProvider>
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
