import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { CostBreakdown } from "./cost-breakdown"
import { compactTokenText, type TaskDetailsStatus } from "./task-details-model"
import { executionCostText, executionMoney } from "./cost"
import { E } from "./i18n"
import { ExecutionPerformance, UsagePopover } from "./usage"

export function TaskStatusIcon(props: { status: TaskDetailsStatus }) {
  const { _ } = useLingui()
  const icon = () => {
    switch (props.status) {
      case "running":
        return "session.running" as const
      case "waiting":
      case "queued":
        return "session.waiting" as const
      case "completed":
        return "state.complete" as const
      case "failed":
        return "state.error" as const
      case "cancelled":
        return "state.cancelled" as const
      case "paused":
      case "interrupted":
        return "session.pause" as const
      default:
        return "state.empty" as const
    }
  }
  return (
    <span class="execution-status-icon" data-state={props.status} aria-label={_(E[props.status])} role="img">
      <Icon name={getSemanticIcon(icon())} size="small" />
    </span>
  )
}

export function CompactExecutionOverview(props: { summary: ExecutionSummary; now: number }) {
  const { _, i18n } = useLingui()
  const tokens = () =>
    compactTokenText(props.summary.accounting.tokens.total, props.summary.accounting.calls, i18n().locale)
  const elapsed = () =>
    executionDuration(
      (props.summary.elapsedMs ?? 0) + (props.summary.elapsedActive ? props.now : 0),
      props.summary.elapsedLowerBound,
    )
  const cost = () =>
    props.summary.cost.state === "local"
      ? executionMoney(0, "USD", i18n().locale)
      : executionCostText(props.summary.cost, i18n().locale)
  const context = () => (props.summary.context?.stale ? null : props.summary.context?.ratio)
  const contextText = () =>
    new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 0 }).format(context() ?? 0)
  return (
    <section class="execution-compact-metrics" aria-label={_(E.overview)}>
      <Tooltip value={_(E[props.summary.status])} hideWhenDetached>
        <span tabindex="0" class="execution-compact-status">
          <TaskStatusIcon status={props.summary.status} />
        </span>
      </Tooltip>
      <div class="execution-compact-values">
        <Show when={props.summary.elapsedMs != null}>
          <span class="execution-compact-metric" aria-label={`${_(E.elapsed)}: ${elapsed()}`}>
            <Icon name={getSemanticIcon("execution.elapsed")} size="small" />
            <span>{elapsed()}</span>
          </span>
        </Show>
        <Show when={tokens()}>
          {(value) => (
            <UsagePopover summary={props.summary} class="execution-compact-metric">
              <Icon name={getSemanticIcon("execution.tokens")} size="small" />
              <span>{value()}</span>
            </UsagePopover>
          )}
        </Show>
        <Show when={cost() !== "—"}>
          <Popover
            title={_(E.cost)}
            class="execution-cost-popover"
            placement="bottom-end"
            triggerAs={(trigger) => (
              <button
                {...trigger}
                type="button"
                class="execution-compact-metric"
                aria-label={`${_(E.cost)}: ${cost()}`}
              >
                <Icon name={getSemanticIcon("execution.cost")} size="small" />
                <span>{cost()}</span>
              </button>
            )}
          >
            <CostBreakdown cost={props.summary.cost} />
          </Popover>
        </Show>
        <Show when={context() != null}>
          <Tooltip value={_(E.context)} hideWhenDetached>
            <span class="execution-compact-metric" tabindex="0" aria-label={`${_(E.context)}: ${contextText()}`}>
              <Icon name={getSemanticIcon("session.context")} size="small" />
              <span>{contextText()}</span>
            </span>
          </Tooltip>
        </Show>
      </div>
      <ExecutionPerformance summary={props.summary} />
    </section>
  )
}
