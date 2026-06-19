import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@/context/sync"
import {
  computeProgressMode,
  computeDagSummary,
  computeProgressIslandSnapshot,
  computeTodoSummary,
  type ProgressLifecycle,
  type ProgressMode,
} from "./session-progress-summary"
import { SessionProgressDag } from "./session-progress-dag"
import { SessionProgressIsland } from "./session-progress-island"
import { SessionProgressTodo } from "./session-progress-todo"

interface SessionProgressPanelProps {
  sessionID: string
  class?: string
}

interface SessionProgressPanelState {
  activeTab: "dag" | "todo"
  expanded: boolean
  visible: boolean
}

export function SessionProgressPanel(props: SessionProgressPanelProps) {
  const sync = useSync()

  const [state, setState] = createStore<SessionProgressPanelState>({
    activeTab: "dag",
    expanded: false,
    visible: false,
  })

  let completionTimer: ReturnType<typeof setTimeout> | undefined

  const clearCompletionTimer = () => {
    clearTimeout(completionTimer)
    completionTimer = undefined
  }

  const dagNodes = createMemo(() => sync.data.dag[props.sessionID] ?? [])
  const todos = createMemo(() => sync.data.todo[props.sessionID] ?? [])

  const hasDag = createMemo(() => dagNodes().length > 0)
  const hasTodo = createMemo(() => todos().length > 0)

  const mode = createMemo<ProgressMode>(() => computeProgressMode(hasDag(), hasTodo()))
  const dagSummary = createMemo(() => (hasDag() ? computeDagSummary(dagNodes()) : undefined))
  const todoSummary = createMemo(() => (hasTodo() ? computeTodoSummary(todos()) : undefined))
  const dagLifecycle = createMemo<ProgressLifecycle>(() => {
    const summary = dagSummary()
    if (!summary) return "active"
    if (summary.total === 0) return "settled"
    if (summary.failed > 0 || summary.blocked > 0) return "active"
    if (summary.running > 0) return "active"
    if (summary.completed >= summary.total) return "settled"

    const sessionStatus = sync.data.session_status[props.sessionID]?.type ?? "idle"
    if (sessionStatus !== "idle") return "active"

    const hasActiveTask = sync.data.cortex.some(
      (task) => task.parentSessionID === props.sessionID && (task.status === "running" || task.status === "queued"),
    )
    return hasActiveTask ? "active" : "paused"
  })
  const snapshot = createMemo(() => computeProgressIslandSnapshot(mode(), dagSummary(), todoSummary(), dagLifecycle()))

  const activeLabel = createMemo(() => {
    const runningNode = dagNodes().find((node) => node.status === "running")
    if (runningNode?.content) return runningNode.content

    const activeTodo = todos().find((todo) => todo.status === "in_progress")
    return activeTodo?.content
  })

  createEffect(
    on(
      () => props.sessionID,
      (_next: string, prev: string | undefined) => {
        if (!prev) return
        clearCompletionTimer()
        setState({ activeTab: "dag", expanded: false, visible: false })
      },
    ),
  )

  createEffect(() => {
    const current = snapshot()
    clearCompletionTimer()

    if (current.status === "hidden") {
      setState({ expanded: false, visible: false })
      return
    }

    setState("visible", true)

    if (current.status === "complete" && !state.expanded) {
      completionTimer = setTimeout(() => setState("visible", false), 1600)
    }
  })

  createEffect(() => {
    const currentMode = mode()
    if (currentMode === "dag") setState("activeTab", "dag")
    else if (currentMode === "todo") setState("activeTab", "todo")
  })

  createEffect(() => {
    if (props.sessionID) {
      sync.session.dag(props.sessionID)
      sync.session.todo(props.sessionID)
    }
  })

  onCleanup(clearCompletionTimer)

  const setExpanded = (expanded: boolean) => {
    clearCompletionTimer()
    setState("expanded", expanded)
    if (!expanded && snapshot().status === "complete") {
      completionTimer = setTimeout(() => setState("visible", false), 1600)
    }
  }

  const renderChild = () => {
    const currentMode = mode()
    if (currentMode === "dag")
      return dagSummary() ? <SessionProgressDag sessionID={props.sessionID} summary={dagSummary()!} /> : null
    if (currentMode === "todo")
      return todoSummary() ? <SessionProgressTodo sessionID={props.sessionID} summary={todoSummary()!} /> : null
    return state.activeTab === "dag" && dagSummary() ? (
      <SessionProgressDag sessionID={props.sessionID} summary={dagSummary()!} />
    ) : todoSummary() ? (
      <SessionProgressTodo sessionID={props.sessionID} summary={todoSummary()!} />
    ) : null
  }

  return (
    <Show when={state.visible && mode() !== "none"}>
      <SessionProgressIsland
        mode={mode() as Exclude<ProgressMode, "none">}
        snapshot={snapshot()}
        activeLabel={activeLabel()}
        activeTab={state.activeTab}
        expanded={state.expanded}
        onExpandedChange={setExpanded}
        onTabChange={(tab) => setState("activeTab", tab)}
        class={props.class}
      >
        {renderChild()}
      </SessionProgressIsland>
    </Show>
  )
}
