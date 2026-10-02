import { createMemo, createSignal, createUniqueId, Show, type JSX } from "solid-js"
import { createInteractOutside } from "@kobalte/core/primitives/create-interact-outside"
import { Popper } from "@kobalte/core/popper"
import { OverlayLayerProvider } from "@ericsanchezok/synergy-ui/context/overlay-layer"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProgressCircle } from "@ericsanchezok/synergy-ui/progress-circle"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
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
}

export function SessionProgressIsland(props: SessionProgressIslandProps) {
  const { i18n } = useLocale()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [panel, setPanel] = createSignal<HTMLDivElement>()
  const panelID = createUniqueId()
  let trigger: HTMLButtonElement | undefined
  const label = createMemo(() => formatProgressLabel(props.snapshot, props.activeLabel, i18n))
  const ariaLabel = () => `${describeProgress(props.snapshot, i18n)}. ${progressExpandCollapse(props.expanded, i18n)}`
  createInteractOutside(
    {
      isDisabled: () => !props.expanded,
      onPointerDownOutside: () => props.onExpandedChange(false),
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
      {i18n._(kind === "dag" ? S.progressDagTab : S.progressTodoTab)}
    </button>
  )
  return (
    <Popper anchorRef={root} contentRef={panel} placement="top" gutter={4} sameWidth fitViewport>
      <div
        ref={setRoot}
        class={`session-progress-island ${props.class ?? ""}`}
        data-expanded={props.expanded}
        data-status={props.snapshot.status}
        data-tone={props.snapshot.tone}
        data-exiting={!!props.exiting}
        onKeyDown={(event) => {
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
          props.onExpandedChange(false)
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
          onClick={() => props.onExpandedChange(!props.expanded)}
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
          <div
            ref={setPanel}
            id={panelID}
            class="session-progress-island-panel"
            role="region"
            aria-label={i18n._(S.progressSessionLabel)}
            aria-hidden={!props.expanded}
            inert={!props.expanded}
          >
            <OverlayLayerProvider layer={root}>
              <div class="session-progress-island-panel-topline">
                <Show when={props.mode === "both"} fallback={<span>{i18n._(S.progressCurrentWork)}</span>}>
                  <div class="session-progress-island-tabs" role="group" aria-label={i18n._(S.progressViewLabel)}>
                    {tab("todo")}
                    {tab("dag")}
                  </div>
                </Show>
                <span class="session-progress-island-count">
                  {props.snapshot.total > 0
                    ? i18n._({
                        ...S.progressCompleteFraction,
                        values: { completed: props.snapshot.completed, total: props.snapshot.total },
                      })
                    : i18n._(S.progressEnded)}
                  <Show when={props.snapshot.cancelled > 0}>
                    <span> · {i18n._({ ...S.progressCancelled, values: { count: props.snapshot.cancelled } })}</span>
                  </Show>
                </span>
              </div>
              <div class="session-progress-island-body">{props.children}</div>
            </OverlayLayerProvider>
          </div>
        </Popper.Positioner>
      </div>
    </Popper>
  )
}
