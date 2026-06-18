import { createMemo, createEffect, createSignal, Show, on } from "solid-js"
import { useSync } from "@/context/sync"
import { DagGraph } from "@ericsanchezok/synergy-ui/dag-graph"
import type { DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import { computeDagSummary, type DagSummary } from "./session-progress-summary"

interface SessionProgressDagProps {
  sessionID: string
  class?: string
}

const STATUS_COLORS: Record<string, string> = {
  completed: "bg-surface-success-base text-text-on-success",
  running: "bg-surface-interactive-base text-text-on-interactive",
  pending: "bg-surface-raised-stronger text-text-weak",
  blocked: "bg-surface-danger-base text-text-on-danger",
  failed: "bg-surface-danger-strong text-text-on-danger",
  cancelled: "bg-surface-raised-stronger text-text-subtle",
}

export function SessionProgressDag(props: SessionProgressDagProps) {
  const sync = useSync()

  const nodes = createMemo<DagNode[]>(() => sync.data.dag[props.sessionID] ?? [])

  const summary = createMemo<DagSummary>(() => computeDagSummary(nodes()))

  const [selectedNodeId, setSelectedNodeId] = createSignal<string | undefined>(undefined)

  const selectedNode = createMemo<DagNode | undefined>(() => {
    const id = selectedNodeId()
    if (!id) return undefined
    return nodes().find((n) => n.id === id)
  })

  createEffect(
    on(
      () => nodes().map((n) => n.id),
      () => {
        const id = selectedNodeId()
        if (id && !nodes().some((n) => n.id === id)) {
          setSelectedNodeId(undefined)
        }
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

  const resultExpanded = createMemo(() => {
    const result = selectedNode()?.result
    if (!result) return false
    return result.length <= 200
  })

  return (
    <Show when={nodes().length > 0} fallback={<div class="text-text-weaker text-xs px-3 py-2">No active plan</div>}>
      <div class={props.class}>
        <DagGraph
          nodes={nodes()}
          ready={summary().ready}
          variant="panel"
          selectedNodeId={selectedNodeId()}
          onSelectNode={handleSelectNode}
        />
        <Show when={selectedNode()}>
          {(node) => (
            <div class="bg-surface-raised-base rounded-lg p-3 mt-2 flex flex-col gap-1.5">
              <div class="flex items-start justify-between gap-2">
                <span class="text-text-strong font-medium text-sm leading-snug">{node().content}</span>
                <span
                  class={`text-11-medium px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[node().status] ?? "bg-surface-raised-stronger text-text-subtle"}`}
                >
                  {node().status}
                </span>
              </div>

              <Show when={node().assign}>
                <span class="text-xs text-text-weak">Assignee: {node().assign}</span>
              </Show>

              <Show when={node().deps.length > 0}>
                <div class="flex flex-wrap items-center gap-1">
                  <span class="text-xs text-text-subtle">Deps:</span>
                  {node().deps.map((dep: string) => (
                    <span class="text-11-regular text-text-weaker bg-surface-raised-stronger-non-alpha rounded px-1 py-px">
                      {dep}
                    </span>
                  ))}
                </div>
              </Show>

              <Show when={node().memo}>
                <div class="bg-surface-raised-stronger-non-alpha rounded-md px-2.5 py-1.5 mt-0.5">
                  <span class="text-xs text-text-base whitespace-pre-wrap">{node().memo}</span>
                </div>
              </Show>

              <Show when={node().result}>
                {(result) => (
                  <details open={resultExpanded()} class="mt-0.5">
                    <summary class="text-xs text-text-weak cursor-pointer select-none hover:text-text-base">
                      Result{result().length > 200 ? ` (${result().length} chars)` : ""}
                    </summary>
                    <div class="bg-surface-raised-stronger-non-alpha rounded-md px-2.5 py-1.5 mt-1">
                      <span class="text-xs text-text-base whitespace-pre-wrap break-words">{result()}</span>
                    </div>
                  </details>
                )}
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
