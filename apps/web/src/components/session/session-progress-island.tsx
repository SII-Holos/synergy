import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, Show, type JSX } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { createInteractOutside } from "@kobalte/core/primitives/create-interact-outside"
import { Popper } from "@kobalte/core/popper"
import { OverlayLayerProvider } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProgressCircle } from "@ericsanchezok/synergy-ui/progress-circle"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import type { ProgressIslandSnapshot, ProgressMode } from "./session-progress-summary"
import { S, describeProgress, progressExpandCollapse, formatProgressLabel } from "./session-i18n"
import "./session-progress-island.css"

interface SessionProgressIslandProps {
  mode: Exclude<ProgressMode, "none">
  snapshot: ProgressIslandSnapshot
  activeLabel?: string
  activeTab: "dag" | "todo"
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  onTabChange(tab: "dag" | "todo"): void
  children: JSX.Element
  class?: string
  exiting?: boolean
  anchor?: HTMLElement
  onPanelMount?(element: HTMLDivElement): void
}

export function SessionProgressIsland(props: SessionProgressIslandProps) {
  const { i18n } = useLingui()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [panel, setPanel] = createSignal<HTMLDivElement>()
  const [close, setClose] = createSignal<HTMLButtonElement>()
  const [compact, setCompact] = createSignal(false)
  const [anchorBounds, setAnchorBounds] = createSignal<DOMRect | undefined>(undefined, {
    equals: (a, b) => a?.top === b?.top && a?.left === b?.left && a?.width === b?.width && a?.height === b?.height,
  })
  const [viewport, setViewport] = createSignal(
    { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight },
    { equals: (a, b) => a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height },
  )
  const panelID = createUniqueId()
  let trigger: HTMLButtonElement | undefined
  const mountPanel = (element: HTMLDivElement) => {
    setPanel(element)
    props.onPanelMount?.(element)
  }
  const changeExpanded = (expanded: boolean) => {
    const restoreFocus = !expanded && panel()?.contains(document.activeElement)
    props.onExpandedChange(expanded)
    if (restoreFocus)
      queueMicrotask(() => {
        if (!props.expanded && trigger?.isConnected && !trigger.closest("[inert]"))
          trigger.focus({ preventScroll: true })
      })
  }
  createEffect(() => {
    const anchor = props.anchor ?? root()
    if (!anchor) return
    const minimum = props.activeTab === "dag" ? 240 : 168
    const measure = () => {
      const visible = window.visualViewport
      const bounds = anchor.getBoundingClientRect()
      setAnchorBounds(bounds)
      setCompact(bounds.top - (visible?.offsetTop ?? 0) < minimum)
      setViewport({
        top: visible?.offsetTop ?? 0,
        left: visible?.offsetLeft ?? 0,
        width: visible?.width ?? window.innerWidth,
        height: visible?.height ?? window.innerHeight,
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    if (anchor.parentElement) observer.observe(anchor.parentElement)
    window.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("scroll", measure)
    measure()
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("scroll", measure)
    })
  })
  createEffect(() => {
    const target = close()
    if (!props.expanded || !compact() || !target) return
    const frame = requestAnimationFrame(() => target.focus({ preventScroll: true }))
    onCleanup(() => cancelAnimationFrame(frame))
  })
  const label = createMemo(() => formatProgressLabel(props.snapshot, props.activeLabel, i18n()))
  const ariaLabel = () =>
    `${describeProgress(props.snapshot, i18n())}. ${progressExpandCollapse(props.expanded, i18n())}`
  createInteractOutside(
    {
      isDisabled: () => !props.expanded || compact(),
      onPointerDownOutside: () => changeExpanded(false),
    },
    root,
  )
  const tab = (kind: "dag" | "todo") => (
    <button
      type="button"
      class="session-progress-island-tab"
      aria-pressed={props.activeTab === kind}
      onClick={() => props.onTabChange(kind)}
    >
      {i18n()._(kind === "dag" ? S.progressDagTab : S.progressTodoTab)}
    </button>
  )
  const content = (
    <OverlayLayerProvider layer={() => (compact() ? panel() : root())}>
      <div class="session-progress-island-panel-topline">
        <Show when={props.mode === "both"} fallback={<span>{i18n()._(S.progressCurrentWork)}</span>}>
          <div class="session-progress-island-tabs" role="group" aria-label={i18n()._(S.progressViewLabel)}>
            {tab("todo")}
            {tab("dag")}
          </div>
        </Show>
        <span class="session-progress-island-count">
          {props.snapshot.total > 0
            ? i18n()._({
                ...S.progressCompleteFraction,
                values: { completed: props.snapshot.completed, total: props.snapshot.total },
              })
            : i18n()._(S.progressEnded)}
          <Show when={props.snapshot.cancelled > 0}>
            <span> · {i18n()._({ ...S.progressCancelled, values: { count: props.snapshot.cancelled } })}</span>
          </Show>
        </span>
        <Show when={compact()}>
          <button
            ref={setClose}
            type="button"
            class="session-progress-island-close"
            aria-label={i18n()._(S.progressClose)}
            onClick={() => changeExpanded(false)}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </button>
        </Show>
      </div>
      <div class="session-progress-island-body">{props.children}</div>
    </OverlayLayerProvider>
  )
  return (
    <Dialog open={props.expanded && compact()} onOpenChange={changeExpanded}>
      <Popper
        anchorRef={() => {
          // Sibling requests can move a retained anchor without resizing it.
          anchorBounds()
          return props.anchor ?? root()
        }}
        contentRef={panel}
        placement="top"
        gutter={6}
        sameWidth
        fitViewport
        flip={false}
      >
        <div
          ref={setRoot}
          class={`session-progress-island ${props.class ?? ""}`}
          data-expanded={props.expanded}
          data-status={props.snapshot.status}
          data-tone={props.snapshot.tone}
          data-exiting={!!props.exiting}
          on:keydown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[data-component="popover-content"], [data-component="dialog"]')
            )
              return
            if (
              event.key !== "Escape" ||
              event.defaultPrevented ||
              event.isComposing ||
              root()?.querySelector('[aria-haspopup="dialog"][aria-expanded="true"]') ||
              !props.expanded ||
              !root()?.contains(document.activeElement)
            )
              return
            event.preventDefault()
            event.stopPropagation()
            changeExpanded(false)
            trigger?.focus()
          }}
        >
          <button
            ref={trigger}
            type="button"
            class="session-progress-island-header"
            aria-label={ariaLabel()}
            aria-controls={panelID}
            aria-expanded={props.expanded}
            onClick={() => changeExpanded(!props.expanded)}
          >
            <span class="session-progress-island-indicator" aria-hidden="true">
              <ProgressCircle percentage={Math.round(props.snapshot.progressRatio * 100)} size={18} strokeWidth={2.5} />
            </span>
            <span class="session-progress-island-title">{label()}</span>
            <Icon
              name={getSemanticIcon("navigation.collapse")}
              size="small"
              class="session-progress-island-chevron"
              classList={{ "is-expanded": props.expanded }}
            />
          </button>
          <Popper.Positioner class="session-progress-island-positioner" style={{ "min-width": "0" }}>
            <Show when={!props.expanded || !compact()}>
              <div
                ref={mountPanel}
                id={panelID}
                class="session-progress-island-panel"
                data-view={props.activeTab}
                role="region"
                aria-label={i18n()._(S.progressSessionLabel)}
                aria-hidden={!props.expanded}
                inert={!props.expanded}
              >
                {content}
              </div>
            </Show>
          </Popper.Positioner>
          <Show when={compact() && props.expanded}>
            <Dialog.Portal>
              <div
                class="session-progress-island-positioner"
                data-compact="true"
                style={{
                  "--progress-viewport-top": `${viewport().top}px`,
                  "--progress-viewport-left": `${viewport().left}px`,
                  "--progress-viewport-width": `${viewport().width}px`,
                  "--progress-viewport-height": `${viewport().height}px`,
                }}
              >
                <Dialog.Overlay class="session-progress-island-backdrop" />
                <Dialog.Content
                  ref={mountPanel}
                  id={panelID}
                  class="session-progress-island-panel"
                  data-view={props.activeTab}
                  data-expanded="true"
                  aria-label={i18n()._(S.progressSessionLabel)}
                  onOpenAutoFocus={(event) => event.preventDefault()}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  {content}
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Show>
        </div>
      </Popper>
    </Dialog>
  )
}
