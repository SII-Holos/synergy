import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@/context/sync"
import {
  computeProgressMode,
  computeDagSummary,
  computeProgressIslandSnapshot,
  computeTodoSummary,
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
  exiting: boolean
}

export function SessionProgressPanel(props: SessionProgressPanelProps) {
  const sync = useSync()

  const [state, setState] = createStore<SessionProgressPanelState>({
    activeTab: "dag",
    expanded: false,
    visible: false,
    exiting: false,
  })

  let completionTimer: ReturnType<typeof setTimeout> | undefined

  const clearCompletionTimer = () => {
    clearTimeout(completionTimer)
    completionTimer = undefined
  }

  const dagNodes = createMemo(() => sync.data.dag[props.sessionID])
  const todos = createMemo(() => sync.data.todo[props.sessionID])
  const dagList = createMemo(() => dagNodes() ?? [])
  const todoList = createMemo(() => todos() ?? [])

  const hasDag = createMemo(() => dagList().length > 0)
  const hasTodo = createMemo(() => todoList().length > 0)
  const isUnknown = createMemo(() => dagNodes() === undefined && todos() === undefined)

  const mode = createMemo<ProgressMode>(() => (isUnknown() ? "none" : computeProgressMode(hasDag(), hasTodo())))
  const dagSummary = createMemo(() => (hasDag() ? computeDagSummary(dagList()) : undefined))
  const todoSummary = createMemo(() => (hasTodo() ? computeTodoSummary(todoList()) : undefined))
  const snapshot = createMemo(() => computeProgressIslandSnapshot(mode(), dagSummary(), todoSummary()))

  const activeLabel = createMemo(() => {
    const runningNode = dagList().find((node) => node.status === "running")
    if (runningNode?.content) return runningNode.content

    const activeTodo = todoList().find((todo) => todo.status === "in_progress")
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
      if (state.visible && !state.exiting) {
        setState("exiting", true)
        completionTimer = setTimeout(() => {
          setState({ expanded: false, visible: false, exiting: false })
        }, 350)
      } else if (!state.visible) {
        setState("exiting", false)
      }
      return
    }
    setState("visible", true)

    // Complete → fade out after delay
    if (current.status === "complete" && !state.expanded) {
      completionTimer = setTimeout(() => {
        setState("exiting", true)
        completionTimer = setTimeout(() => {
          setState({ expanded: false, visible: false, exiting: false })
        }, 350)
      }, 1600)
    } else {
      setState("exiting", false)
    }
  })

  createEffect(() => {
    const currentMode = mode()
    if (currentMode === "dag") setState("activeTab", "dag")
    else if (currentMode === "todo") setState("activeTab", "todo")
  })

  onCleanup(clearCompletionTimer)

  const setExpanded = (expanded: boolean) => {
    clearCompletionTimer()
    setState("expanded", expanded)
    if (!expanded && snapshot().status === "complete") {
      completionTimer = setTimeout(() => {
        setState("exiting", true)
        completionTimer = setTimeout(() => {
          setState({ expanded: false, visible: false, exiting: false })
        }, 350)
      }, 1600)
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
      <div class="relative w-full">
        <SessionProgressIsland
          mode={mode() as Exclude<ProgressMode, "none">}
          snapshot={snapshot()}
          activeLabel={activeLabel()}
          activeTab={state.activeTab}
          expanded={state.expanded}
          onExpandedChange={setExpanded}
          onTabChange={(tab) => setState("activeTab", tab)}
          class={props.class}
          exiting={state.exiting}
        >
          {renderChild()}
        </SessionProgressIsland>
      </div>
    </Show>
  )
}
