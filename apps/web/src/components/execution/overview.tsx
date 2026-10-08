import { createMemo, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionCostPresentation, ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { E, K } from "./i18n"
import { contextWorkspace as C } from "@/locales/messages"
import { ActivityExplorer } from "./chart"
import { executionCostText, executionMoney } from "./cost"
import { ExecutionPerformance, UsagePopover } from "./usage"
import "./execution.css"

export function executionDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  return (
    Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0") +
    ":" +
    (seconds % 60).toString().padStart(2, "0")
  )
}
export function CostBreakdown(props: { cost: ExecutionCostPresentation }) {
  const { _, i18n } = useLingui()
  return (
    <dl class="execution-detail-rows execution-cost-breakdown">
      <For each={props.cost.reported}>
        {(value) => (
          <div>
            <dt>{_(E.reported)}</dt>
            <dd>{executionMoney(value.amount, value.currency, i18n().locale)}</dd>
          </div>
        )}
      </For>
      <For each={props.cost.estimates}>
        {(value) => (
          <div>
            <dt>{_(value.basis === "historical" ? E.historicalCost : E.knownEstimate)}</dt>
            <dd>
              {executionMoney(value.known, "USD", i18n().locale)}
              <Show when={value.maximum > value.known}>–{executionMoney(value.maximum, "USD", i18n().locale)}</Show>
              <Show when={value.basis === "unclassified"}>
                <small>{_(E.unknownBilling)}</small>
              </Show>
            </dd>
          </div>
        )}
      </For>
      <Show when={props.cost.equivalent}>
        {(value) => (
          <div>
            <dt>{_(E.subscription)}</dt>
            <dd>{executionMoney(value().known, "USD", i18n().locale)}</dd>
          </div>
        )}
      </Show>
      <Show when={props.cost.missing}>
        <div>
          <dt>{_(E.partial)}</dt>
          <dd>{_({ ...E.missingCost, values: { count: props.cost.missing } })}</dd>
        </div>
      </Show>
      <Show when={props.cost.state === "local" || props.cost.state === "unrecorded"}>
        <div>
          <dt>{_(E.cost)}</dt>
          <dd>{_(props.cost.state === "local" ? E.localCost : E.noCost)}</dd>
        </div>
      </Show>
    </dl>
  )
}
export function ExecutionOverview(props: {
  summary: ExecutionSummary
  now?: number
  compact?: boolean
  quick?: boolean
  onLocate?: (id: string) => void
}) {
  const { _, i18n } = useLingui()
  const dialog = useDialog()
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const metric = () => {
    const value = props.summary.accounting.tokens.total
    return value.known || (value.total !== null && props.summary.accounting.calls)
      ? (value.unknown ? "≥ " : "") + number(value.known)
      : "—"
  }
  const elapsed = () =>
    (props.summary.elapsedMs ?? 0) +
    (props.summary.elapsedActive ? Math.max(0, (props.now ?? props.summary.computedAt) - props.summary.computedAt) : 0)
  const ratio = () => (props.summary.context?.stale ? null : props.summary.context?.ratio)
  const context = () =>
    ratio() == null
      ? "—"
      : new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 0 }).format(ratio()!)
  const distribution = createMemo(() => {
    const snapshot = props.summary.contextDistribution
    if (!snapshot || ratio() == null || !props.summary.context?.limit) return []
    return [
      {
        key: "conversation",
        label: _(C.categoryConversation),
        tokens: snapshot.categories.conversation.attributedTokens,
      },
      {
        key: "toolActivity",
        label: _(C.categoryToolActivity),
        tokens: snapshot.categories.toolActivity.attributedTokens,
      },
      {
        key: "filesReferences",
        label: _(C.categoryFilesReferences),
        tokens: snapshot.categories.filesReferences.attributedTokens,
      },
      {
        key: "instructions",
        label: _(C.categoryInstructions),
        tokens: snapshot.categories.instructions.attributedTokens,
      },
      { key: "overhead", label: _(C.categoryOverhead), tokens: snapshot.overhead.attributedTokens },
    ].map((value) => ({ ...value, width: (value.tokens / props.summary.context!.limit!) * 100 }))
  })
  const contextHelp = () =>
    distribution().length
      ? distribution()
          .map((value) => value.label + " " + number(value.tokens))
          .join(" · ")
      : _(props.summary.context?.stale ? E.contextStale : ratio() == null ? E.contextUnknown : E.context)
  const explore = () => {
    if (props.onLocate) dialog.push(() => <ActivityExplorer summary={props.summary} onLocate={props.onLocate!} />)
  }
  return (
    <section
      class="execution-overview"
      classList={{ "execution-overview--compact": props.compact, "execution-overview--quick": props.quick }}
      aria-label={_(E.title)}
    >
      <div class="execution-overview-state">
        <span class="execution-state" data-state={props.summary.status}>
          {_(E[props.summary.status])}
        </span>
        <Show when={props.summary.coverage.partial || props.summary.coverage.gaps}>
          <Tooltip value={_(props.summary.coverage.recorded ? E.partialHelp : E.legacy)}>
            <span class="execution-record-note">{_(E.partial)}</span>
          </Tooltip>
        </Show>
        <span class="execution-subtask-count">
          {_(E.tasks)} {props.summary.tasks.length}
          <Show when={props.summary.tasks.some((task) => task.status === "running")}>
            {" "}
            · {_(E.running)} {props.summary.tasks.filter((task) => task.status === "running").length}
          </Show>
        </span>
      </div>
      <dl class="execution-metrics">
        <div>
          <dt>{_(E.elapsed)}</dt>
          <dd>{props.summary.elapsedMs != null ? executionDuration(elapsed()) : "—"}</dd>
        </div>
        <div>
          <dt>{_(E.tokens)}</dt>
          <dd>
            <UsagePopover summary={props.summary} class="execution-cost-button">
              {metric()}
            </UsagePopover>
          </dd>
        </div>
        <div>
          <dt>{_(E.cost)}</dt>
          <dd>
            <Popover
              title={_(E.cost)}
              class="execution-cost-popover"
              placement="bottom-end"
              triggerAs={(trigger) => (
                <button {...trigger} type="button" class="execution-cost-button" aria-label={_(E.cost)}>
                  {props.summary.cost?.state === "local"
                    ? _(E.localCost)
                    : executionCostText(props.summary.cost, i18n().locale)}
                </button>
              )}
            >
              <Show when={props.summary.cost}>{(cost) => <CostBreakdown cost={cost()} />}</Show>
            </Popover>
          </dd>
        </div>
        <div>
          <dt>{_(E.context)}</dt>
          <dd>{context()}</dd>
        </div>
      </dl>
      <ExecutionPerformance summary={props.summary} />
      <Tooltip value={contextHelp()}>
        <div
          class="execution-context-bar"
          role="meter"
          aria-label={_(E.context)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ratio() == null ? undefined : Math.round(Math.min(1, ratio()!) * 100)}
          aria-valuetext={context()}
        >
          <Show
            when={distribution().length}
            fallback={<span style={{ width: ratio() == null ? "0%" : Math.min(100, ratio()! * 100) + "%" }} />}
          >
            <For each={distribution()}>
              {(value) => <span data-category={value.key} style={{ width: Math.min(100, value.width) + "%" }} />}
            </For>
          </Show>
        </div>
      </Tooltip>
      <Show when={!props.quick}>
        <button
          type="button"
          class="execution-overview-chart"
          aria-label={_(E.chartExpand)}
          onClick={explore}
          disabled={!props.onLocate}
        >
          <span class="execution-chart-caption">
            {_(E.activityOrder)}
            <span>{_(E.chartExpand)}</span>
          </span>
          <For each={props.summary.lanes}>
            {(lane) => (
              <span class="execution-lane">
                <span>{_(K[lane.kind])}</span>
                <span class="execution-lane-track" aria-hidden="true">
                  <For each={props.summary.activitySegments?.slice(1)}>
                    {(segment) => (
                      <span
                        class="execution-lane-divider"
                        style={{ left: (segment.from / Math.max(1, props.summary.activityTotal)) * 100 + "%" }}
                      />
                    )}
                  </For>
                  <For each={lane.nodes}>
                    {(node) => (
                      <span
                        class="execution-lane-mark"
                        data-kind={lane.kind}
                        data-state={node.status}
                        style={{
                          left:
                            Math.min(
                              99,
                              ((node.activity?.index ?? 0) / Math.max(1, props.summary.activityTotal)) * 100,
                            ) + "%",
                          width:
                            Math.max(
                              0.5,
                              ((node.activity?.count ?? 1) / Math.max(1, props.summary.activityTotal)) * 100,
                            ) + "%",
                        }}
                      />
                    )}
                  </For>
                </span>
                <small>{lane.total}</small>
              </span>
            )}
          </For>
        </button>
      </Show>
    </section>
  )
}
