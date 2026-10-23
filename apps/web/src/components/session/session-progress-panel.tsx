import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useSessionDataView } from "@/context/session-data-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { classifySessionActivity, resolveSessionStatus, type SessionActivity } from "@/utils/session-status"
import {
  computeProgressMode,
  computeDagSummary,
  computeProgressIslandSnapshot,
  computeTodoSummary,
} from "./session-progress-summary"
import { SessionProgressDag } from "./session-progress-dag"
import { SessionProgressIsland } from "./session-progress-island"
import { SessionProgressTodo } from "./session-progress-todo"
import { useSessionSurfaceFocus } from "./session-surface-focus"

export function SessionProgressPanel(props: {
  sessionID: string
  class?: string
  anchor?: HTMLElement
  suppressed?: boolean
}) {
  const view = useSessionDataView()
  const sdk = useSDK()
  const sync = useSync()
  const returnFocus = useSessionSurfaceFocus()
  const [tab, setTab] = createSignal<"todo" | "dag">("todo")
  const [expanded, setExpanded] = createSignal(false)
  const [dagMounted, setDagMounted] = createSignal(false)
  const [phase, setPhase] = createSignal<"hidden" | "visible" | "ending" | "exiting">("hidden")
  let timer: ReturnType<typeof setTimeout> | undefined
  let root: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined
  const containsFocus = () => root?.contains(document.activeElement) || panel?.contains(document.activeElement)
  let disposed = false
  const returnAfterClose = (contained: boolean | undefined) => {
    if (!contained) return
    const sessionID = props.sessionID
    queueMicrotask(() => {
      if (!disposed && props.sessionID === sessionID) returnFocus()
    })
  }
  const cancelEnd = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const hide = () => {
    const contained = containsFocus()
    setExpanded(false)
    setPhase("hidden")
    returnAfterClose(contained)
  }
  const dag = createMemo(() => view().dagNodesFor(props.sessionID))
  const todo = createMemo(() => view().todosFor(props.sessionID))
  const mode = createMemo(() => computeProgressMode(dag().length > 0, todo().length > 0))
  const activeTab = () => (mode() === "dag" ? "dag" : mode() === "todo" ? "todo" : tab())
  const dagSummary = createMemo(() => computeDagSummary(dag()))
  const todoSummary = createMemo(() => computeTodoSummary(todo()))
  const snapshot = createMemo(() =>
    computeProgressIslandSnapshot(mode() === "none" ? "none" : activeTab(), dagSummary(), todoSummary()),
  )
  const viewSummary = () => (activeTab() === "dag" ? dagSummary() : todoSummary())
  const activeLabel = () =>
    snapshot().source === "todo"
      ? todo().find((item) => item.status === "in_progress")?.content
      : dag().find((item) => item.status === "running")?.content
  createEffect(
    on(
      () => props.sessionID,
      () => {
        setTab("todo")
        setDagMounted(false)
        setExpanded(false)
      },
    ),
  )
  const activity = createMemo<SessionActivity | "unknown">(() => {
    if (!sync.ready || !sdk.connected()) return "unknown"
    const children = view()
      .sessions()
      .filter((item) => item.parentID === props.sessionID)
    const tasks = view()
      .cortexTasks()
      .filter((item) => item.parentSessionID === props.sessionID)
    const related = new Set([
      props.sessionID,
      ...children.map((item) => item.id),
      ...tasks.map((item) => item.sessionID),
    ])
    const activities = [...related].map((id) => {
      const working = view().sessionFor(id)?.working
      const runtimeStatus = view().statusFor(id)
      const waiting = view().questionsFor(id).length > 0 || view().permissionsFor(id).length > 0
      if (waiting) return "waiting"
      if (!runtimeStatus && !working && tasks.some((task) => task.sessionID === id && task.status === "running"))
        return "working"
      return classifySessionActivity({ status: resolveSessionStatus({ runtimeStatus, working }) })
    })
    if (activities.includes("waiting")) return "waiting"
    if (activities.includes("working")) return "working"
    if (activities.includes("paused")) return "paused"
    return "idle"
  })
  createEffect(
    on(
      () => ({
        sessionID: props.sessionID,
        status: view().sessionFor(props.sessionID) ? snapshot().status : "hidden",
        reading: expanded(),
      }),
      (current, previous) => {
        if (current.sessionID !== previous?.sessionID) {
          cancelEnd()
          setPhase("hidden")
        }
        if (current.status === "hidden") {
          cancelEnd()
          hide()
          return
        }
        if (current.status !== "complete") {
          cancelEnd()
          setPhase("visible")
          return
        }
        if (phase() === "hidden") return
        if (current.reading) {
          cancelEnd()
          setPhase("visible")
          return
        }
        if (timer) return
        setPhase("ending")
        timer = setTimeout(() => {
          timer = undefined
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            hide()
            return
          }
          const contained = containsFocus()
          setExpanded(false)
          setPhase("exiting")
          returnAfterClose(contained)
          timer = setTimeout(() => {
            timer = undefined
            hide()
          }, 180)
        }, 1600)
      },
    ),
  )
  createEffect(() => {
    if (props.suppressed) {
      const contained = containsFocus()
      setExpanded(false)
      returnAfterClose(contained)
    }
  })
  createEffect(() => {
    if (expanded() && activeTab() === "dag") setDagMounted(true)
  })
  onCleanup(() => {
    disposed = true
    cancelEnd()
  })
  return (
    <Show when={phase() !== "hidden"}>
      <div
        ref={root}
        class="session-progress-panel relative w-full"
        hidden={props.suppressed}
        inert={props.suppressed || phase() === "exiting"}
        aria-hidden={props.suppressed}
      >
        <SessionProgressIsland
          mode={mode() as "dag" | "todo" | "both"}
          snapshot={snapshot()}
          activity={activity()}
          viewSummary={viewSummary()}
          activeLabel={activeLabel()}
          activeTab={activeTab()}
          expanded={expanded()}
          onExpandedChange={setExpanded}
          onTabChange={setTab}
          class={props.class}
          exiting={phase() === "exiting"}
          anchor={props.anchor}
          onPanelMount={(element) => {
            panel = element
          }}
        >
          <div
            class="session-progress-view"
            data-active={activeTab() === "todo"}
            aria-hidden={!expanded() || activeTab() !== "todo"}
            inert={!expanded() || activeTab() !== "todo"}
          >
            <SessionProgressTodo sessionID={props.sessionID} />
          </div>
          <Show when={dagMounted()}>
            <div
              class="session-progress-view session-progress-dag-view"
              data-active={activeTab() === "dag"}
              aria-hidden={!expanded() || activeTab() !== "dag"}
              inert={!expanded() || activeTab() !== "dag"}
            >
              <SessionProgressDag
                sessionID={props.sessionID}
                summary={dagSummary()}
                frozen={!expanded() || activeTab() !== "dag"}
              />
            </div>
          </Show>
        </SessionProgressIsland>
      </div>
    </Show>
  )
}
