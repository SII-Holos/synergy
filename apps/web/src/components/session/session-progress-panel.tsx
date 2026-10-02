import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import { useSessionDataView } from "@/context/session-data-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { classifySessionActivity, resolveSessionStatus } from "@/utils/session-status"
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

export function SessionProgressPanel(props: { sessionID: string; class?: string }) {
  const view = useSessionDataView()
  const sdk = useSDK()
  const sync = useSync()
  const returnFocus = useSessionSurfaceFocus()
  const [tab, setTab] = createSignal<"todo" | "dag">("todo")
  const [expanded, setExpanded] = createSignal(false)
  const [dagMounted, setDagMounted] = createSignal(false)
  const [phase, setPhase] = createSignal<"hidden" | "visible" | "ending" | "exiting">("hidden")
  let observedActivity = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let root: HTMLDivElement | undefined
  const cancelEnd = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const hide = () => {
    if (root?.contains(document.activeElement)) returnFocus()
    setExpanded(false)
    setPhase("hidden")
  }
  const dag = createMemo(() => view().dagNodesFor(props.sessionID))
  const todo = createMemo(() => view().todosFor(props.sessionID))
  const mode = createMemo(() => computeProgressMode(dag().length > 0, todo().length > 0))
  const activeTab = () => (mode() === "dag" ? "dag" : mode() === "todo" ? "todo" : tab())
  const dagSummary = createMemo(() => computeDagSummary(dag()))
  const todoSummary = createMemo(() => computeTodoSummary(todo()))
  const snapshot = createMemo(() => computeProgressIslandSnapshot(activeTab(), dagSummary(), todoSummary()))
  const activeLabel = () =>
    activeTab() === "todo"
      ? todo().find((item) => item.status === "in_progress")?.content
      : dag().find((item) => item.status === "running")?.content
  createEffect(
    on(
      () => props.sessionID,
      () => {
        cancelEnd()
        observedActivity = false
        setTab("todo")
        setDagMounted(false)
        setExpanded(false)
        setPhase("hidden")
      },
    ),
  )
  createEffect(() => {
    const session = view().sessionFor(props.sessionID)
    const children = view()
      .sessions()
      .filter((item) => item.parentID === props.sessionID)
    const waiting =
      view().questionsFor(props.sessionID).length > 0 ||
      [props.sessionID, ...children.map((item) => item.id)].some((id) => view().permissionsFor(id).length > 0)
    const activity = classifySessionActivity({
      status: resolveSessionStatus({
        runtimeStatus: view().statusFor(props.sessionID),
        working: session?.working,
      }),
      waiting,
    })
    const currentMode = mode()
    const known = sync.ready && !!session && sdk.connected()
    untrack(() => {
      if (!known) {
        cancelEnd()
        if (phase() === "ending" || phase() === "exiting") setPhase("visible")
        return
      }
      if (activity !== "idle") {
        observedActivity = true
        cancelEnd()
        setPhase(currentMode === "none" ? "hidden" : "visible")
        return
      }
      if (!observedActivity || phase() === "hidden" || timer) return
      if (currentMode === "none") {
        hide()
        return
      }
      setPhase("ending")
      timer = setTimeout(() => {
        timer = undefined
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          hide()
          return
        }
        setPhase("exiting")
        timer = setTimeout(() => {
          timer = undefined
          hide()
        }, 180)
      }, 1600)
    })
  })
  createEffect(() => {
    if (expanded() && activeTab() === "dag") setDagMounted(true)
  })
  onCleanup(cancelEnd)
  return (
    <Show when={phase() !== "hidden" && mode() !== "none"}>
      <div ref={root} class="relative w-full">
        <SessionProgressIsland
          mode={mode() as "dag" | "todo" | "both"}
          snapshot={snapshot()}
          activeLabel={activeLabel()}
          activeTab={activeTab()}
          expanded={expanded()}
          onExpandedChange={setExpanded}
          onTabChange={setTab}
          class={props.class}
          exiting={phase() === "exiting"}
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
