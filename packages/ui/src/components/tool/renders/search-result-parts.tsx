import { For, Show } from "solid-js"
import { ToolTextOutput } from "../../tool-output-text"
import type { ToolResultRow } from "../anysearch-info"
import "./search-result.css"

export type SearchSummaryRow = { label: string; value?: string | number } | undefined

/** Label/value strip rendered above search result bodies. */
export function SearchSummary(props: { rows: SearchSummaryRow[] }) {
  const visible = () =>
    props.rows.filter((row) => row && row.value !== undefined) as Array<{
      label: string
      value: string | number
    }>
  return (
    <Show when={visible().length > 0}>
      <div data-component="search-summary">
        <For each={visible()}>
          {(row) => (
            <div data-slot="search-summary-row">
              <span data-slot="search-summary-label">{row.label}</span>
              <span data-slot="search-summary-value">{row.value}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/** Title + optional meta rows for parsed search/paper results. */
export function SearchResultRows(props: { rows: ToolResultRow[]; limit?: number }) {
  return (
    <Show when={props.rows.length > 0}>
      <div data-component="search-result-list">
        <For each={props.rows.slice(0, props.limit ?? props.rows.length)}>
          {(row) => (
            <div data-slot="search-result-row">
              <span data-slot="search-result-title">{row.title}</span>
              <Show when={row.meta}>
                <span data-slot="search-result-meta">{row.meta}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/** Standard raw-text tool output body. */
export function RawToolOutput(props: { output?: string }) {
  return (
    <Show when={props.output}>
      {(output) => (
        <div data-component="tool-output" data-scrollable>
          <ToolTextOutput text={output()} />
        </div>
      )}
    </Show>
  )
}
