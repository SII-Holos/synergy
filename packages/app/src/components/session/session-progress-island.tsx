import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProgressCircle } from "@ericsanchezok/synergy-ui/progress-circle"
import { useLocale } from "@/context/locale"
import { formatProgressIslandLabel, type ProgressIslandSnapshot, type ProgressMode } from "./session-progress-summary"
import "./session-progress-island.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { S, describeProgress, progressExpandCollapse, formatProgressLabel } from "./session-i18n"

interface SessionProgressIslandProps {
  mode: Exclude<ProgressMode, "none">
  snapshot: ProgressIslandSnapshot
  activeLabel?: string
  activeTab: "dag" | "todo"
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onTabChange: (tab: "dag" | "todo") => void
  children: JSX.Element
  class?: string
  exiting?: boolean
}

export function SessionProgressIsland(props: SessionProgressIslandProps) {
  let rootRef: HTMLDivElement | undefined
  const { i18n } = useLocale()

  const [panelRef, setPanelRef] = createSignal<HTMLDivElement | undefined>(undefined)
  const [bodyRef, setBodyRef] = createSignal<HTMLDivElement | undefined>(undefined)
  const [panelHeight, setPanelHeight] = createSignal<number | undefined>(undefined)

  const label = createMemo(() => formatProgressLabel(props.snapshot, props.activeLabel, i18n))
  const percentage = createMemo(() => Math.round(props.snapshot.progressRatio * 100))
  const ariaLabel = createMemo(
    () => `${describeProgress(props.snapshot, i18n)}. ${progressExpandCollapse(props.expanded, i18n)} details.`,
  )

  const setExpanded = (expanded: boolean) => {
    props.onExpandedChange(expanded)
  }

  onMount(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && props.expanded) setExpanded(false)
    }
    const clickHandler = (event: MouseEvent) => {
      if (!props.expanded || !rootRef) return
      const target = event.target as HTMLElement | undefined
      if (target?.closest('[data-slot="dag-node-preview"]')) return
      if (!rootRef.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener("keydown", keyHandler)
    document.addEventListener("click", clickHandler)
    onCleanup(() => {
      document.removeEventListener("keydown", keyHandler)
      document.removeEventListener("click", clickHandler)
    })
  })

  createEffect(() => {
    const shouldMeasure =
      props.expanded && (props.mode === "todo" || (props.mode === "both" && props.activeTab === "todo"))
    if (!shouldMeasure) {
      setPanelHeight(undefined)
      return
    }
    const body = bodyRef()
    const panel = panelRef()
    if (!body || !panel) return
    const measure = () => {
      const content = body.firstElementChild as HTMLElement | null
      const contentHeight = content?.scrollHeight ?? body.scrollHeight
      if (contentHeight <= 0) return
      const topline = panel.querySelector(".session-progress-island-panel-topline")
      const tabs = panel.querySelector(".session-progress-island-tabs")
      const overhead = (topline?.scrollHeight ?? 0) + (tabs?.scrollHeight ?? 0)
      const maxH = Math.min(window.innerHeight * 0.52, 560)
      setPanelHeight(Math.min(contentHeight + overhead, maxH))
    }
    const raf = requestAnimationFrame(measure)
    const observer = new MutationObserver(measure)
    observer.observe(body, { childList: true, subtree: true, characterData: true })
    onCleanup(() => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    })
  })

  const tab = (kind: "dag" | "todo") => {
    const selected = () => props.activeTab === kind
    return (
      <button
        type="button"
        class="session-progress-island-tab"
        classList={{ "is-selected": selected() }}
        aria-pressed={selected()}
        onClick={() => props.onTabChange(kind)}
      >
        {kind === "dag" ? i18n._(S.progressDagTab) : i18n._(S.progressTodoTab)}
      </button>
    )
  }

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class={`session-progress-island ${props.class ?? ""}`}
      data-expanded={props.expanded ? "true" : "false"}
      data-status={props.snapshot.status}
      data-tone={props.snapshot.tone}
      data-exiting={props.exiting ? "true" : "false"}
    >
      <div class="session-progress-island-surface statusbar-glass">
        <button
          type="button"
          class="session-progress-island-header"
          aria-label={ariaLabel()}
          aria-controls="session-progress-island-panel"
          aria-expanded={props.expanded}
          onClick={() => setExpanded(!props.expanded)}
        >
          <span class="session-progress-island-indicator" aria-hidden="true">
            <ProgressCircle percentage={percentage()} size={18} strokeWidth={2.5} />
          </span>
          <span class="session-progress-island-title">{label()}</span>
          <Icon
            name={getSemanticIcon("navigation.collapse")}
            size="small"
            class="session-progress-island-chevron"
            classList={{ "is-expanded": props.expanded }}
          />
        </button>
        <div
          class="session-progress-island-panel-wrap"
          data-expanded={props.expanded ? "true" : "false"}
          aria-hidden={!props.expanded}
          style={panelHeight() != null ? { height: `${panelHeight()}px` } : undefined}
        >
          <div
            id="session-progress-island-panel"
            class="session-progress-island-panel"
            ref={(el) => {
              setPanelRef(el)
            }}
            style={panelHeight() != null ? { height: `${panelHeight()}px` } : undefined}
          >
            <div class="session-progress-island-panel-topline">
              <span>{i18n._(S.progressCurrentWork)}</span>
              <span class="text-text-weaker">
                {i18n._({
                  ...S.progressCompleteFraction,
                  values: { completed: props.snapshot.completed, total: props.snapshot.total },
                })}
                <Show when={props.snapshot.status !== "complete"}>
                  {props.snapshot.active > 0
                    ? ` · ${i18n._({ ...S.progressActiveCount, values: { count: props.snapshot.active } })}`
                    : ` · ${i18n._({ ...S.progressWaitingCount, values: { count: props.snapshot.pending } })}`}
                </Show>
              </span>
            </div>
            <Show when={props.mode === "both"}>
              <div class="session-progress-island-tabs" role="group" aria-label={i18n._(S.progressViewLabel)}>
                {tab("dag")}
                {tab("todo")}
              </div>
            </Show>
            <div
              class="session-progress-island-body"
              ref={(el) => {
                setBodyRef(el)
              }}
            >
              {props.children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
