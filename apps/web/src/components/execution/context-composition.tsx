import { createMemo, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionContextSnapshot } from "@ericsanchezok/synergy-sdk/client"
import { contextCategories, contextRows, D } from "./context-categories"

export function ContextComposition(props: {
  snapshot?: ExecutionContextSnapshot
  category: string
  highlight?: string
  onHighlight?: (value: string) => void
  onCategory: (value: string) => void
}) {
  const { _, i18n } = useLingui()
  const rows = createMemo(() => contextRows(props.snapshot?.usage ?? undefined))
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const total = () => props.snapshot?.inputTokens
  const emphasized = () => props.highlight || props.category
  const limit = () => props.snapshot?.contextLimit
  const ratio = () => (total() == null || !limit() ? null : total()! / limit()!)
  const percent = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 1 }).format(value)
  return (
    <section class="context-composition" aria-label={_(D.composition)}>
      <div class="context-composition-heading">
        <div>
          <h2>{_(D.current)}</h2>
          <p>
            {_(D.latest)}
            <Show when={props.snapshot}> · {props.snapshot?.modelID}</Show>
          </p>
        </div>
      </div>
      <div class="context-current-total">
        <strong>{total() == null ? "—" : number(total()!)}</strong>
        <span>
          / {limit() ? number(limit()!) : "—"} {_(D.tokenUnit)}
        </span>
        <b>{ratio() == null ? "—" : percent(ratio()!)}</b>
      </div>
      <div
        class="context-capacity-track"
        role="meter"
        aria-label={_(D.capacity)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio() == null ? undefined : Math.min(100, ratio()! * 100)}
        aria-valuetext={ratio() == null ? "—" : percent(ratio()!)}
      >
        <For each={rows()}>
          {(row) => (
            <span
              style={{ width: (limit() ? (row.attributedTokens / limit()!) * 100 : 0) + "%", background: row.color }}
            />
          )}
        </For>
      </div>
      <div class="context-composition-body">
        <div class="context-legend">
          <Show
            when={rows().length}
            fallback={<p class="context-note">{_(props.snapshot ? D.unavailable : D.noRequests)}</p>}
          >
            <For each={rows().map((row) => row.category)}>
              {(category) => {
                const row = () => rows().find((entry) => entry.category === category)!
                return (
                  <button
                    type="button"
                    class="context-legend-row"
                    aria-pressed={props.category === category}
                    data-highlighted={emphasized() === category}
                    onMouseEnter={() => props.onHighlight?.(category)}
                    onMouseLeave={() => props.onHighlight?.("")}
                    onFocus={() => props.onHighlight?.(category)}
                    onBlur={() => props.onHighlight?.("")}
                    disabled={category === "overhead"}
                    onClick={() => props.onCategory(props.category === category ? "" : category)}
                  >
                    <span class="context-dot" style={{ background: row().color }} />
                    <span title={_(contextCategories[category].label)}>{_(contextCategories[category].label)}</span>
                    <strong>≈{number(row().attributedTokens)}</strong>
                    <small>{percent(total() ? row().attributedTokens / total()! : 0)}</small>
                  </button>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
      <div class="context-capacity">
        <div class="context-capacity-note">
          <span>{_(D.estimated)}</span>
          <Show when={limit() && total() != null}>
            <span>{_({ ...D.remaining, values: { tokens: number(Math.max(0, limit()! - total()!)) } })}</span>
          </Show>
        </div>
      </div>
    </section>
  )
}
