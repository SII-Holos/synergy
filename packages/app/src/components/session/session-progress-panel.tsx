import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useSync } from "@/context/sync"
import {
  computeProgressMode,
  computeDagSummary,
  computeTodoSummary,
  type ProgressMode,
} from "./session-progress-summary"
import { SessionProgressRail } from "./session-progress-rail"
import { SessionProgressDrawer } from "./session-progress-drawer"
import { SessionProgressDag } from "./session-progress-dag"
import { SessionProgressTodo } from "./session-progress-todo"

interface SessionProgressPanelProps {
  sessionID: string
  class?: string
}

export function SessionProgressPanel(props: SessionProgressPanelProps) {
  const sync = useSync()

  const hasDag = createMemo(() => (sync.data.dag[props.sessionID]?.length ?? 0) > 0)
  const hasTodo = createMemo(() => (sync.data.todo[props.sessionID]?.length ?? 0) > 0)

  const mode = createMemo<ProgressMode>(() => computeProgressMode(hasDag(), hasTodo()))

  const dagSummary = createMemo(() => {
    const nodes = sync.data.dag[props.sessionID]
    if (!nodes) return undefined
    return computeDagSummary(nodes)
  })

  const todoSummary = createMemo(() => {
    const todos = sync.data.todo[props.sessionID]
    if (!todos) return undefined
    return computeTodoSummary(todos)
  })

  const [expanded, setExpanded] = createSignal(false)
  const [activeTab, setActiveTab] = createSignal<"dag" | "todo">("dag")

  // Auto-close and reset on sessionID change
  createEffect(
    on(
      () => props.sessionID,
      (_next: string, prev: string | undefined) => {
        if (prev) {
          setExpanded(false)
          setActiveTab("dag")
        }
      },
    ),
  )

  // Auto-close when all data disappears while expanded
  createEffect(() => {
    if (expanded() && mode() === "none") {
      setExpanded(false)
    }
  })

  // Default tab to the active mode when data appears
  createEffect(() => {
    const m = mode()
    if (m === "dag") setActiveTab("dag")
    else if (m === "todo") setActiveTab("todo")
  })

  // Lazy data fetch (idempotent)
  createEffect(() => {
    if (props.sessionID) {
      sync.session.dag(props.sessionID)
      sync.session.todo(props.sessionID)
    }
  })

  const renderChild = () => {
    const m = mode()
    if (m === "dag") return <SessionProgressDag sessionID={props.sessionID} />
    if (m === "todo") return <SessionProgressTodo sessionID={props.sessionID} />
    return activeTab() === "dag" ? (
      <SessionProgressDag sessionID={props.sessionID} />
    ) : (
      <SessionProgressTodo sessionID={props.sessionID} />
    )
  }

  const railMode = createMemo(() => mode() as "dag" | "todo" | "both")

  return (
    <Show when={mode() !== "none"}>
      <div class={`relative flex flex-col ${props.class ?? ""}`}>
        <SessionProgressRail
          mode={railMode()}
          dagSummary={dagSummary()}
          todoSummary={todoSummary()}
          expanded={expanded()}
          onClick={() => setExpanded((v) => !v)}
        />
        <Show when={expanded()}>
          <SessionProgressDrawer
            mode={railMode()}
            activeTab={activeTab()}
            onTabChange={setActiveTab}
            onClose={() => setExpanded(false)}
            dagSummary={dagSummary()}
            todoSummary={todoSummary()}
          >
            {renderChild()}
          </SessionProgressDrawer>
        </Show>
      </div>
    </Show>
  )
}
