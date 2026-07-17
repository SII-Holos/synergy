import { createMemo, createEffect, createSignal, Show, on, onCleanup } from "solid-js"
import { useSync } from "@/context/sync"
import { useLocale } from "@/context/locale"
import { DagGraph } from "@ericsanchezok/synergy-ui/dag-graph"
import { useNavigate, useParams } from "@solidjs/router"
import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import type { DagSummary } from "./session-progress-summary"
import { S } from "./session-i18n"

interface SessionProgressDagProps {
  sessionID: string
  summary: DagSummary
  frozen?: boolean
  class?: string
}

export function SessionProgressDag(props: SessionProgressDagProps) {
  const sync = useSync()
  const navigate = useNavigate()
  const params = useParams()
  const { i18n } = useLocale()
  const nodes = createMemo<DagNode[]>(() => sync.data.dag[props.sessionID] ?? [])
  const [userInteracted, setUserInteracted] = createSignal(false)
  let previousNodes = new Map<string, string>()

  const changedNodeId = createMemo(() => {
    const current = nodes()
    if (previousNodes.size === 0 && current.length > 0) {
      for (const n of current) previousNodes.set(n.id, n.status)
      return undefined
    }
    const changed: Array<{ id: string; newStatus: string }> = []
    for (const n of current) {
      const prev = previousNodes.get(n.id)
      if (prev && prev !== n.status) changed.push({ id: n.id, newStatus: n.status })
      previousNodes.set(n.id, n.status)
    }
    if (changed.length === 0) return undefined
    const first = (s: string) => changed.find((c) => c.newStatus === s)
    return first("failed")?.id ?? first("blocked")?.id ?? first("running")?.id ?? changed[0].id
  })

  const [debouncedNodeId, setDebouncedNodeId] = createSignal<string | undefined>(undefined)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const id = changedNodeId()
    if (id === undefined) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      setDebouncedNodeId(id)
    }, 120)
  })
  onCleanup(() => clearTimeout(debounceTimer))

  const focusNodeId = createMemo(() => {
    if (userInteracted() || nodes().length === 0 || nodes().length > 200) return undefined
    return debouncedNodeId()
  })
  const [selectedNodeId, setSelectedNodeId] = createSignal<string | undefined>(undefined)
  createEffect(
    on(
      () => nodes().map((n) => n.id),
      () => {
        const id = selectedNodeId()
        if (id && !nodes().some((n) => n.id === id)) setSelectedNodeId(undefined)
      },
    ),
  )

  const handleSelectNode = (node: DagNode) => {
    if (selectedNodeId() === node.id) {
      setSelectedNodeId(undefined)
    } else {
      setSelectedNodeId(node.id)
    }
  }
  const openSession = (sessionID: string) => {
    navigate(`/${params.dir}/session/${sessionID}`)
  }

  return (
    <Show
      when={nodes().length > 0}
      fallback={<div class="text-text-weaker text-xs px-3 py-2">{i18n._(S.progressNoActivePlan)}</div>}
    >
      <div class={props.class ? `${props.class} h-full` : "h-full"}>
        <DagGraph
          nodes={nodes()}
          ready={props.summary.ready}
          variant="panel"
          frozen={props.frozen}
          selectedNodeId={selectedNodeId()}
          onSelectNode={handleSelectNode}
          focusNodeId={focusNodeId()}
          onViewportInteraction={() => setUserInteracted(true)}
          onOpenSession={openSession}
        />
      </div>
    </Show>
  )
}
