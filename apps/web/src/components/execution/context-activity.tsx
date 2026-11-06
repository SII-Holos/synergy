import { Button } from "@ericsanchezok/synergy-ui/button"
import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { D } from "./context-categories"
import { E } from "./i18n"

export type ExecutionRecordsTarget = {
  nodeID?: string
  runID?: string
  kinds?: string[]
  statuses?: string[]
  anomalies?: boolean
  actor?: "all"
}

export function ContextActivity(props: {
  summary: ExecutionSummary
  onRecords: (target?: ExecutionRecordsTarget) => void
}) {
  const { _ } = useLingui()
  const tools = () => props.summary.tools.reduce((sum, tool) => sum + tool.calls, 0)
  const failed = () => props.summary.tools.reduce((sum, tool) => sum + tool.failed, 0)
  return (
    <section class="context-activity" aria-label={_(D.taskActivity)}>
      <div class="context-section-heading">
        <h3>{_(D.taskActivity)}</h3>
        <Button size="small" variant="ghost" onClick={() => props.onRecords()}>
          {_(D.records)}
        </Button>
      </div>
      <div class="context-activity-counts">
        <button type="button" onClick={() => props.onRecords({ kinds: ["tool"], actor: "all" })}>
          {_({ ...D.toolCount, values: { count: tools() } })}
        </button>
        <button
          type="button"
          disabled={!props.summary.outcomes.retries}
          onClick={() => props.onRecords({ kinds: ["retry"], anomalies: true, actor: "all" })}
        >
          {_({ ...D.retryCount, values: { count: props.summary.outcomes.retries } })}
        </button>
        <Show when={failed()}>
          <button
            type="button"
            data-state="failed"
            onClick={() => props.onRecords({ kinds: ["tool"], statuses: ["failed"], actor: "all" })}
          >
            {_({ ...D.failedTools, values: { count: failed() } })}
          </button>
        </Show>
        <Show when={props.summary.tasks.length}>
          <button type="button" onClick={() => props.onRecords({ kinds: ["subtask"] })}>
            {_(E.tasks)} {props.summary.tasks.length}
          </button>
        </Show>
      </div>
      <For each={props.summary.rounds.slice(-4).reverse()}>
        {(round) => (
          <button type="button" class="context-round-row" onClick={() => props.onRecords({ runID: round.id })}>
            <span class="context-round-number">
              {props.summary.rounds.findIndex((entry) => entry.id === round.id) + 1}
            </span>
            <span class="context-round-title" title={round.title}>
              {round.title || _(E.unassigned)}
            </span>
            <span class="context-round-status">
              <span>{_(E[round.status])}</span>
              <time>{round.elapsedMs == null ? "—" : executionDuration(round.elapsedMs, round.elapsedLowerBound)}</time>
            </span>
          </button>
        )}
      </For>
      <Show when={props.summary.coverage.partial || props.summary.coverage.gaps}>
        <p class="context-note">{_(E.partialHelp)}</p>
      </Show>
    </section>
  )
}
