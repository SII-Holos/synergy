import { useExtensionOutlet } from "@ericsanchezok/synergy-ui/context/extension-outlet"
import {
  ErrorBoundary,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  on,
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
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useWorkbenchPanels } from "@/context/workbench"
import {
  resolveWorkbenchEscapeAction,
  isEditableEscapeTarget,
  workbenchAddablePanels,
  workbenchPanelMountKey,
} from "@/context/workbench/panel-model"
import {
  WORKSPACE_MIN_WIDTH,
  WORKSPACE_SESSION_MIN_WIDTH,
  sidebarOccupancy,
  workspacePresentation,
} from "@/context/layout/workspace"
import { useLayout } from "@/context/layout"
import type {
  WorkbenchPanelContentProps,
  WorkbenchPanelEntry,
  WorkbenchPanelSurface,
  WorkbenchPanelTab,
} from "@/plugin/registries/workbench-panel-registry"
import "./workbench-surface.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { resourceMenuKeyDown } from "./resource-menu"
import { workspaceTabStops } from "./focus"
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
import { createWorkbenchPanelLoader } from "./workbench-panel-loader"

function WorkbenchPanelContent(props: {
  entry: WorkbenchPanelEntry
  tab: WorkbenchPanelTab
  onRequestClose: () => void
}) {
  const panel = createWorkbenchPanelLoader<Component<WorkbenchPanelContentProps>>(
    props.entry.loader,
    props.entry.component ?? null,
  )

  onMount(() => {
    void panel.load()
  })

  return (
    <Show
      when={!panel.loading()}
      fallback={
        <div class="workbench-surface-loading">
          <Spinner class="size-5" />
        </div>
      }
    >
      <Show
        when={panel.component()}
        fallback={
          <div class="workbench-surface-empty workbench-surface-load-error">
            <span>
              <Trans id={W.panelUnavailable.id} message={W.panelUnavailable.message} />
            </span>
            <Show when={panel.error()}>
              <div class="workbench-surface-load-error-actions">
                <Button type="button" variant="secondary" size="small" onClick={() => void panel.load()}>
                  <Trans id={W.panelRetry.id} message={W.panelRetry.message} />
                </Button>
                <Button type="button" variant="ghost" size="small" onClick={() => window.location.reload()}>
                  <Trans id={W.panelReload.id} message={W.panelReload.message} />
                </Button>
              </div>
            </Show>
          </div>
        }
      >
        {(component) => (
          <ErrorBoundary
            fallback={(error, reset) => (
              <div class="workbench-surface-error" role="alert">
                <Icon name={getSemanticIcon("state.warning")} size="large" />
                <span>
                  <Trans id="app.workspace.panel.failed" message="This panel encountered a problem." />
                </span>
                <Button variant="secondary" onClick={reset}>
                  <Trans id="app.workspace.panel.retryRendering" message="Retry panel" />
                </Button>
                <details>
                  <summary>
                    <Trans id="app.workspace.panel.details" message="Error details" />
                  </summary>
                  <pre>{error instanceof Error ? error.message : String(error)}</pre>
                </details>
              </div>
            )}
          >
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
  onCloseOthers: () => void
  onCloseRight: () => void
  onContextMenu: () => void
  onContextMenuOpenChange: (open: boolean) => void
  menuOpen: boolean
  onFocusIndex: (index: number) => void
}) {
  const lingui = useLingui()
  const sortable = createSortable(props.tab.id)
  let main!: HTMLButtonElement
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) main?.scrollIntoView({ block: "nearest", inline: "nearest" })
      },
    ),
  )
  const currentIndex = () => props.tabs.findIndex((tab) => tab.id === props.tab.id)
  return (
    <div
      use:sortable
      class="workbench-surface-tab"
      classList={{
        "workbench-surface-tab--active": props.active,
        "workbench-surface-tab--dragging": sortable.isActiveDraggable,
        "workbench-surface-tab--context": props.menuOpen,
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        props.onClose()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onContextMenu()
      }}
    >
      <button
        ref={main}
        type="button"
        role="tab"
        class="workbench-surface-tab-main"
        aria-selected={props.active}
        aria-label={props.title}
        title={props.title}
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
        tabIndex={props.active ? 0 : -1}
        aria-label={lingui._({
          id: W.closeTab.id,
          message: W.closeTab.message,
          values: { title: props.title },
        })}
        on:pointerdown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose()
        }}
      >
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
      <Popover
        open={props.menuOpen}
        onOpenChange={(open) => {
          if (!open) props.onContextMenuOpenChange(false)
        }}
        placement="bottom-start"
        gutter={6}
        class="workbench-surface-add-menu"
        trigger={<span aria-hidden="true" />}
      >
        <div
          class="workbench-surface-add-list"
          role="menu"
          onKeyDown={resourceMenuKeyDown}
          aria-label={lingui._({
            id: W.tabContextMenu.id,
            message: W.tabContextMenu.message,
            values: { title: props.title },
          })}
        >
          <For each={props.entry?.tabActions?.(props.tab)}>
            {(action) => (
              <button
                type="button"
                role="menuitem"
                class="workbench-surface-add-row"
                disabled={action.disabled}
                onClick={() => {
                  props.onContextMenuOpenChange(false)
                  void action.run()
                }}
              >
                <span>{action.label}</span>
              </button>
            )}
          </For>
          <button
            type="button"
            class="workbench-surface-add-row"
            role="menuitem"
            onClick={() => {
              props.onContextMenuOpenChange(false)
              props.onClose()
            }}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
            <span>{lingui._({ id: W.closeTab.id, message: W.closeTab.message, values: { title: props.title } })}</span>
          </button>
          <button
            type="button"
            class="workbench-surface-add-row"
            role="menuitem"
            disabled={props.tabs.length < 2}
            onClick={() => {
              props.onContextMenuOpenChange(false)
              props.onCloseOthers()
            }}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
            <span>
              <Trans id={W.closeOtherTabs.id} message={W.closeOtherTabs.message} />
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="workbench-surface-add-row"
            disabled={currentIndex() === props.tabs.length - 1}
            onClick={() => {
              props.onContextMenuOpenChange(false)
              props.onCloseRight()
            }}
          >
            <span>{lingui._({ id: "workbench.closeRight", message: "Close tabs to the right" })}</span>
          </button>
        </div>
      </Popover>
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

export function WorkbenchSurface(props: { surface: WorkbenchPanelSurface; modalHost?: boolean }) {
  useExtensionOutlet(`workbench.${props.surface}`)
  const lingui = useLingui()
  const dialog = useDialog()
  const workbench = useWorkbenchPanels()
  const layout = useLayout()
  const [local, setLocal] = createStore({
    addOpen: false,
    actionsOpen: false,
    menuTabId: undefined as string | undefined,
    resizing: false,
    initialized: false,
    overflow: false,
  })
  const state = createMemo(() => workbench.surface(props.surface))
  const activeTab = createMemo(() => state().activeTab())
  const activeEntry = createMemo(() => workbench.panelForTab(activeTab()))
  const activePanel = createMemo(() => {
    const tab = activeTab()
    const entry = activeEntry()
    if (!tab || !entry) return undefined
    return { tab, entry }
  })
  const panelMountKey = createMemo(() => {
    const panel = activePanel()
    return panel ? workbenchPanelMountKey(panel.tab) : undefined
  })
  const addablePanels = createMemo(() => workbenchAddablePanels(workbench.panels(props.surface), state().tabs()))
  const showTabActions = createMemo(() => {
    const tabs = state().tabs()
    return tabs.length > 1 && activeTab() !== undefined && local.overflow
  })

  const closeOtherTabs = () => {
    setLocal("actionsOpen", false)
    const tab = activeTab()
    if (!tab) return
    void workbench.closeOtherTabs(tab.id)
  }
  let tabRun: HTMLDivElement | undefined
  let root: HTMLDivElement | undefined
  let returnFocus: HTMLElement | undefined
  const measureOverflow = () => setLocal("overflow", Boolean(tabRun && tabRun.scrollWidth > tabRun.clientWidth + 1))
  createEffect(() => {
    state()
      .tabs()
      .forEach((tab) => workbench.panelTitle(tab))
    queueMicrotask(measureOverflow)
  })
  onMount(() => {
    const observer = new ResizeObserver(measureOverflow)
    if (tabRun) observer.observe(tabRun)
    measureOverflow()
    onCleanup(() => observer.disconnect())
  })
  const visited = new Set<string>()
  const [visitedVersion, setVisitedVersion] = createSignal(0)
  createEffect(() => {
    const id = panelMountKey()
    if (state().opened() && id && !visited.has(id)) {
      visited.add(id)
      setVisitedVersion((value) => value + 1)
    }
  })
  createEffect(() => {
    if (!state().opened() || activePanel() || !workbench.getPanel("resource-home")) return
    void workbench.openPanel(workbench.getPanel("browser") ? "browser" : "resource-home", { intent: "restore" })
  })
  createEffect(
    on(
      () => state().opened(),
      (opened) => {
        const active = document.activeElement
        if (opened) {
          if (active instanceof HTMLElement && !root?.contains(active)) returnFocus = active
          return
        }
        if (root?.contains(active) && returnFocus?.isConnected) queueMicrotask(() => returnFocus?.focus())
      },
    ),
  )

  const openPanel = (panel: WorkbenchPanelEntry, mode: "launcher" | "add") => {
    setLocal("addOpen", false)
    const empty = activeTab()?.panelId === "resource-home" ? activeTab()?.id : undefined
    void workbench.openPanel(panel.id, {
      forceNew: !empty && mode === "add" && panel.cardinality === "multi",
      reuseExisting: mode === "launcher",
      replaceTab: empty,
    })
  }

  createEffect(() => {
    if (!state().opened()) {
      setLocal("addOpen", false)
      setLocal("actionsOpen", false)
      setLocal("menuTabId", undefined)
    }
  })

  createEffect(() => {
    if (addablePanels().length === 0) setLocal("addOpen", false)
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (
        event.key === "Tab" &&
        isSide() &&
        state().opened() &&
        presentation().overlay &&
        root?.contains(event.target as Node) &&
        !dialog.active &&
        !local.addOpen &&
        !local.actionsOpen &&
        !local.menuTabId
      ) {
        const focusable = workspaceTabStops(root)
        const index = focusable.indexOf(document.activeElement as HTMLElement)
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === focusable.length - 1)) {
          event.preventDefault()
          focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus()
        }
        return
      }
      const nestedOverlay =
        event.target instanceof Element ? event.target.closest('[role="dialog"], [role="menu"]') : undefined
      const action = resolveWorkbenchEscapeAction({
        key: event.key,
        opened: state().opened(),
        menuOpen: local.addOpen || local.actionsOpen || local.menuTabId !== undefined,
        focusWithin: event.target instanceof Node && Boolean(root?.contains(event.target)),
        dialogActive: Boolean(
          dialog.active || (nestedOverlay && nestedOverlay !== root && root?.contains(nestedOverlay)),
        ),
        editableFocus: isEditableEscapeTarget(event.target),
      })
      if (action === "none") return
      event.preventDefault()
      event.stopPropagation()
      state().close()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("keydown", onKey)
    })
  })

  const size = () => state().size()
  const isSide = () => props.surface === "side"
  const [available, setAvailable] = createStore({
    width: window.innerWidth,
    height: window.innerHeight,
    container: false,
    integratedSidebar: false,
  })
  onMount(() => {
    const container = root?.closest<HTMLElement>('[data-ui-part="session"]')
    const shell = container?.closest<HTMLElement>("[data-default-shell]")
    const integratedSidebar = Boolean(shell?.querySelector(".sb-integrated"))
    const widthContainer = integratedSidebar ? shell : container
    const measure = () => {
      const rect = container?.getBoundingClientRect()
      setAvailable({
        width: widthContainer?.getBoundingClientRect().width ?? window.innerWidth,
        height: rect?.height ?? window.innerHeight,
        container: Boolean(rect),
        integratedSidebar,
      })
    }
    const observer = widthContainer ? new ResizeObserver(measure) : undefined
    if (widthContainer) observer?.observe(widthContainer)
    if (container && container !== widthContainer) observer?.observe(container)
    window.addEventListener("resize", measure)
    measure()
    requestAnimationFrame(() => setLocal("initialized", true))
    onCleanup(() => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    })
  })
  const splitAvailableWidth = () =>
    available.width -
    (available.integratedSidebar
      ? sidebarOccupancy(layout.isDesktop(), layout.sidebar.opened(), layout.sidebar.width())
      : available.container
        ? 0
        : layout.sidebar.occupiedWidth())
  const maxSideWidth = () => Math.max(0, splitAvailableWidth() - WORKSPACE_SESSION_MIN_WIDTH)
  const maxBottomHeight = () => Math.max(0, available.height * 0.6)
  const presentation = createMemo(() => workspacePresentation(splitAvailableWidth(), size(), state().fullscreen()))
  const displaySize = () =>
    isSide() ? (presentation().overlay ? available.width : presentation().width) : Math.min(size(), maxBottomHeight())
  createEffect(() => {
    if (!isSide() || !root) return
    const container = root.closest<HTMLElement>("[data-default-session]")
    if (!container) return
    const previous = container.style.getPropertyValue("--workspace-side-width")
    container.style.setProperty(
      "--workspace-side-width",
      state().opened() && !presentation().overlay ? `${displaySize()}px` : "0px",
    )
    onCleanup(() => {
      if (previous) container.style.setProperty("--workspace-side-width", previous)
      else container.style.removeProperty("--workspace-side-width")
    })
  })
  createEffect(() => {
    if (!isSide() || !root) return
    const pane = root.closest('[data-ui-part="session"]')?.querySelector<HTMLElement>(".session-workbench-pane")
    if (!pane || !state().opened() || !presentation().overlay) return
    const wasInert = pane.inert
    pane.inert = true
    const navigation = root
      .closest("[data-default-session]")
      ?.closest("[data-default-shell]")
      ?.querySelector<HTMLElement>(".sb-integrated")
    const navigationInert = navigation?.inert
    if (navigation) navigation.inert = true
    if (pane.contains(document.activeElement)) root.querySelector<HTMLButtonElement>("button")?.focus()
    onCleanup(() => {
      pane.inert = wasInert
      if (navigation) navigation.inert = navigationInert ?? false
    })
  })
  const hidden = () => !state().opened() || (!props.modalHost && displaySize() === 0)

  const rootStyle = () =>
    props.modalHost
      ? { width: "100%", height: "100%" }
      : isSide()
        ? { width: state().opened() ? `${displaySize()}px` : "0px" }
        : { height: state().opened() ? `${displaySize()}px` : "0px" }

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
      ref={root}
      inert={hidden()}
      aria-hidden={hidden()}
      onPointerDown={() => workbench.interact()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") workbench.interact()
      }}
      data-ui-part="resource-panel"
      data-workspace-width={displaySize()}
      role={!props.modalHost && isSide() && state().opened() && presentation().overlay ? "dialog" : undefined}
      aria-modal={!props.modalHost && isSide() && state().opened() && presentation().overlay ? true : undefined}
      aria-label={!props.modalHost && isSide() && presentation().overlay ? lingui._(W.sideWorkspace) : undefined}
      class="workbench-surface"
      classList={{
        "workbench-surface--side": isSide(),
        "workbench-surface--bottom": !isSide(),
        "workbench-surface--open": state().opened(),
        "workbench-surface--resizing": local.resizing,
        "workbench-surface--overlay": isSide() && state().opened() && presentation().overlay,
        "workbench-surface--initialized": local.initialized,
      }}
      style={rootStyle()}
    >
      <Show when={!props.modalHost && (!isSide() || !presentation().overlay)}>
        <ResizeHandle
          direction={isSide() ? "horizontal" : "vertical"}
          edge="start"
          aria-label={
            isSide()
              ? lingui._({ id: W.resizeSide.id, message: W.resizeSide.message })
              : lingui._({ id: W.resizeBottom.id, message: W.resizeBottom.message })
          }
          size={displaySize()}
          min={Math.min(isSide() ? WORKSPACE_MIN_WIDTH : 120, isSide() ? maxSideWidth() : maxBottomHeight())}
          max={isSide() ? maxSideWidth() : maxBottomHeight()}
          collapseThreshold={isSide() ? 200 : 50}
          onResize={state().setSize}
          onResizeStart={() => setLocal("resizing", true)}
          onResizeEnd={() => setLocal("resizing", false)}
          onCollapse={state().close}
        />
      </Show>
      <aside
        class="workbench-surface-panel"
        role="complementary"
        aria-label={
          isSide()
            ? lingui._({ id: W.sideWorkspace.id, message: W.sideWorkspace.message })
            : lingui._({ id: W.bottomWorkspace.id, message: W.bottomWorkspace.message })
        }
      >
        <Show when={state().tabs().length > 0 || isSide()}>
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
                        onActivate={() => workbench.activateTab(props.surface, tab.id)}
                        onClose={() => void workbench.closeTab(tab.id)}
                        onCloseOthers={() => void workbench.closeOtherTabsOnSurface(props.surface, tab.id)}
                        onCloseRight={() => void workbench.closeOtherTabsOnSurface(props.surface, tab.id, "right")}
                        onContextMenu={() => setLocal("menuTabId", tab.id)}
                        onContextMenuOpenChange={(open) => {
                          if (!open) setLocal("menuTabId", undefined)
                        }}
                        menuOpen={local.menuTabId === tab.id}
                        onFocusIndex={focusTab}
                      />
                    )}
                  </For>
                </SortableProvider>
              </div>
            </DragDropProvider>
            <div class="workbench-surface-controls">
              <div class="workbench-surface-add-group">
                <Show when={isSide()}>
                  <IconButton
                    icon={getSemanticIcon("action.add")}
                    variant="ghost"
                    aria-label={lingui._({ id: "workspace.tab.new", message: "New tab" })}
                    onClick={() =>
                      void workbench.openPanel(workbench.getPanel("browser") ? "browser" : "resource-home", {
                        forceNew: true,
                      })
                    }
                  />
                </Show>
                <Show when={addablePanels().length > 0}>
                  <div class="workbench-surface-add-wrap">
                    <Popover
                      open={local.addOpen}
                      onOpenChange={(open) => setLocal("addOpen", open)}
                      placement="bottom-start"
                      gutter={6}
                      class="workbench-surface-add-menu"
                      triggerAs={(triggerProps) => (
                        <IconButton
                          {...triggerProps}
                          icon={getSemanticIcon(isSide() ? "navigation.collapse" : "action.add")}
                          variant="ghost"
                          aria-label={
                            isSide()
                              ? lingui._({ id: "workspace.resource.open", message: "Open a resource" })
                              : lingui._({ id: W.addBottomPanel.id, message: W.addBottomPanel.message })
                          }
                          aria-haspopup="menu"
                          aria-expanded={local.addOpen}
                        />
                      )}
                    >
                      <div class="workbench-surface-add-list" role="menu" onKeyDown={resourceMenuKeyDown}>
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
              <Show when={showTabActions()}>
                <div class="workbench-surface-actions-wrap">
                  <Popover
                    open={local.actionsOpen}
                    onOpenChange={(open) => setLocal("actionsOpen", open)}
                    placement="bottom-start"
                    gutter={6}
                    class="workbench-surface-add-menu"
                    triggerAs={(triggerProps) => (
                      <IconButton
                        {...triggerProps}
                        icon={getSemanticIcon("action.more")}
                        variant="ghost"
                        aria-label={lingui._({ id: W.tabActionsMenu.id, message: W.tabActionsMenu.message })}
                        aria-haspopup="menu"
                        aria-expanded={local.actionsOpen}
                      />
                    )}
                  >
                    <div class="workbench-surface-add-list" role="menu" onKeyDown={resourceMenuKeyDown}>
                      <For each={state().tabs()}>
                        {(tab) => (
                          <button
                            type="button"
                            role="menuitem"
                            class="workbench-surface-add-row"
                            onClick={() => {
                              workbench.activateTab(props.surface, tab.id)
                              setLocal("actionsOpen", false)
                            }}
                          >
                            {workbench.panelTitle(tab)}
                          </button>
                        )}
                      </For>
                      <button type="button" class="workbench-surface-add-row" role="menuitem" onClick={closeOtherTabs}>
                        <Icon name={getSemanticIcon("action.close")} size="small" />
                        <span>
                          <Trans id={W.closeOtherTabs.id} message={W.closeOtherTabs.message} />
                        </span>
                      </button>
                    </div>
                  </Popover>
                </div>
              </Show>

              <Show when={isSide()}>
                <Tooltip
                  value={
                    state().fullscreen()
                      ? lingui._({ id: "workspace.fullscreen.exit", message: "Exit full screen" })
                      : lingui._({ id: "workspace.fullscreen.enter", message: "Full screen" })
                  }
                >
                  <IconButton
                    icon={getSemanticIcon(state().fullscreen() ? "window.restore" : "workspace.fullscreen")}
                    variant="ghost"
                    aria-label={
                      state().fullscreen()
                        ? lingui._({ id: "workspace.fullscreen.exit", message: "Exit full screen" })
                        : lingui._({ id: "workspace.fullscreen.enter", message: "Full screen" })
                    }
                    aria-pressed={state().fullscreen()}
                    onClick={() => state().setFullscreen(!state().fullscreen())}
                  />
                </Tooltip>
                <Tooltip value={lingui._({ id: "workspace.collapse", message: "Collapse workspace" })}>
                  <IconButton
                    icon={getSemanticIcon("workspace.collapse")}
                    variant="ghost"
                    onClick={() => state().close()}
                    aria-label={lingui._({ id: "workspace.collapse", message: "Collapse workspace" })}
                  />
                </Tooltip>
              </Show>
            </div>
          </div>
        </Show>
        <div class="workbench-surface-body">
          <Show
            when={
              (visitedVersion(),
              panelMountKey() && (state().opened() || visited.has(panelMountKey()!)) ? panelMountKey() : undefined)
            }
            keyed
            fallback={<Launcher surface={props.surface} panels={addablePanels()} onOpen={openPanel} />}
          >
            {(_tabId) => (
              <WorkbenchPanelContent
                entry={activePanel()!.entry}
                tab={activePanel()!.tab}
                onRequestClose={() => {
                  const tab = activeTab()
                  if (!tab) return
                  void workbench.closeTab(tab.id)
                }}
              />
            )}
          </Show>
        </div>
      </aside>
    </div>
  )
}
