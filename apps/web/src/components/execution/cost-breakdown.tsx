import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionCostPresentation } from "@ericsanchezok/synergy-sdk/client"
import { E } from "./i18n"
import { executionMoney } from "./cost"
import "./execution.css"

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
