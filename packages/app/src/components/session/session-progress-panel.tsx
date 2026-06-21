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
  exiting: boolean
  lastHiddenFingerprint: string | undefined
}

export function SessionProgressPanel(props: SessionProgressPanelProps) {
  const sync = useSync()

  const [state, setState] = createStore<SessionProgressPanelState>({
    activeTab: "dag",
    expanded: false,
    visible: false,
    exiting: false,
    lastHiddenFingerprint: undefined,
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
    if (summary.completed >= summary.total) return "settled"

    // If the session is idle with no active background tasks, the DAG is no
    // longer making progress — treat it as settled so the panel can dismiss
    // even when the agent forgot to mark every node terminal.
    const sessionStatus = sync.data.session_status[props.sessionID]?.type ?? "idle"
    if (sessionStatus === "idle") {
      const hasActiveTask = sync.data.cortex.some(
        (task) => task.parentSessionID === props.sessionID && (task.status === "running" || task.status === "queued"),
      )
      if (!hasActiveTask) return "settled"
    }

    if (summary.failed > 0 || summary.blocked > 0) return "active"
    if (summary.running > 0) return "active"
    return "active"
  })
  const snapshot = createMemo(() => computeProgressIslandSnapshot(mode(), dagSummary(), todoSummary(), dagLifecycle()))

  const dagFingerprint = createMemo(() =>
    dagNodes()
      .map((n) => `${n.id}:${n.status}`)
      .sort()
      .join("|"),
  )

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

    // Case 1: snapshot says hidden — record fingerprint if it's an orphaned DAG
    if (current.status === "hidden") {
      const fp = dagFingerprint()
      if (fp && (dagLifecycle() === "settled" || dagLifecycle() === "paused")) {
        setState("lastHiddenFingerprint", fp)
      }
      // If currently visible, play exit animation first
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

    // Case 2: snapshot says non-hidden — check fingerprint
    const fp = dagFingerprint()
    if (state.lastHiddenFingerprint === fp && fp) {
      // Stale DAG, no changes since last hidden → keep hidden
      if (state.visible) {
        setState("exiting", true)
        completionTimer = setTimeout(() => {
          setState({ expanded: false, visible: false, exiting: false })
        }, 350)
      }
      return
    }

    // Fingerprint changed or never hidden → clear fingerprint, show normally
    if (state.lastHiddenFingerprint !== undefined) {
      setState("lastHiddenFingerprint", undefined)
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
