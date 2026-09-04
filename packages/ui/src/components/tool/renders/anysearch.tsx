import { createMemo, For, Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { Spinner } from "../../spinner"
import { ToolRegistry } from "../../message-part"
import type { ToolProps } from "../../tool-registry-lazy"
import {
  ANYSEARCH_TOOL_NAMES,
  batchSearchView,
  getAnysearchToolInfo,
  parseToolResultRows,
  toolDomainLabels,
  toolElapsedLabel,
  toolFirstString,
  toolHostname,
  type AnysearchToolName,
} from "../anysearch-info"
import { RawToolOutput, SearchResultRows, SearchSummary, type SearchSummaryRow } from "./search-result-parts"
import { useLingui } from "@lingui/solid"
import { SEARCH_TOOL_DESC } from "../../tool-title-descriptors"

const TOP_RESULT_ROWS = 3

function resultCountLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`
}

function triggerFromInfo(name: AnysearchToolName, props: ToolProps) {
  const info = getAnysearchToolInfo(name, props.input ?? {})
  return {
    icon: info.icon,
    title: info.title,
    subtitle: info.subtitle || "",
    tags: info.args?.map((label) => ({ label })),
  }
}

/** Search (B): summary strip with queried domains / result count / elapsed,
 * then up to three parsed top-result rows; plain text falls back to the
 * standard text output body. */
function renderSearch(name: AnysearchToolName, props: ToolProps) {
  const input = () => props.input ?? {}
  const rows = createMemo(() => parseToolResultRows(props.output))
  const { _ } = useLingui()
  const strip = (): SearchSummaryRow[] => [
    { label: _(SEARCH_TOOL_DESC.domains), value: toolDomainLabels(input()).join(", ") || undefined },
    rows() ? { label: _(SEARCH_TOOL_DESC.results), value: resultCountLabel(rows()!.length) } : undefined,
    { label: _(SEARCH_TOOL_DESC.elapsed), value: toolElapsedLabel(props.time) },
  ]
  return (
    <BasicTool {...props} trigger={triggerFromInfo(name, props)}>
      <SearchSummary rows={strip()} />
      <Show when={rows()} fallback={<RawToolOutput output={props.output} />}>
        {(parsed) => <SearchResultRows rows={parsed()} limit={TOP_RESULT_ROWS} />}
      </Show>
    </BasicTool>
  )
}

/** Extract / domain discovery (B): the header carries the query target and
 * the summary strip carries the host/domains plus output format; the body is
 * long-form text (fetched page, domain list), so it keeps the raw output. */
function renderTextResult(name: AnysearchToolName, props: ToolProps) {
  const input = () => props.input ?? {}
  const format = () => toolFirstString(input().format)
  const { _ } = useLingui()
  return (
    <BasicTool {...props} trigger={triggerFromInfo(name, props)}>
      <SearchSummary
        rows={[
          name === "mcp__anysearch__extract"
            ? { label: _(SEARCH_TOOL_DESC.host), value: toolHostname(input().url) }
            : { label: _(SEARCH_TOOL_DESC.domains), value: toolDomainLabels(input()).join(", ") || undefined },
          format() ? { label: _(SEARCH_TOOL_DESC.format), value: format() } : undefined,
          { label: _(SEARCH_TOOL_DESC.elapsed), value: toolElapsedLabel(props.time) },
        ]}
      />
      <RawToolOutput output={props.output} />
    </BasicTool>
  )
}

/** Batch search (C): pending lists the queries with a spinner row; completed
 * renders one row per query with its parsed result count, a footer with the
 * summed total and elapsed time, and unparseable output falls back to text. */
function renderBatchSearch(name: AnysearchToolName, props: ToolProps) {
  const view = createMemo(() => batchSearchView(props.input ?? {}, props.output, props.time, props.status))
  const { _ } = useLingui()
  return (
    <BasicTool {...props} trigger={triggerFromInfo(name, props)}>
      <Show when={!view().pending} fallback={<BatchPending queries={view().queries} />}>
        <Show when={view().rows} fallback={<RawToolOutput output={props.output} />}>
          {(rows) => (
            <div data-component="search-batch-body">
              <div data-component="search-batch-list">
                <For each={rows()}>
                  {(row) => (
                    <div data-slot="search-batch-row">
                      <span data-slot="search-batch-query">{row.query}</span>
                      <Show when={row.count !== undefined}>
                        <span data-slot="search-batch-count">{resultCountLabel(row.count!)}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <div data-component="search-batch-footer">
                <span data-slot="search-batch-total">
                  {_(SEARCH_TOOL_DESC.total)}
                  {view().total !== undefined ? resultCountLabel(view().total!) : ""}
                </span>
                <Show when={view().elapsed}>
                  <span data-slot="search-batch-elapsed">{view().elapsed}</span>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </BasicTool>
  )
}

function BatchPending(props: { queries: string[] }) {
  const { _ } = useLingui()
  return (
    <div data-component="search-batch-list">
      <For each={props.queries}>
        {(query) => (
          <div data-slot="search-batch-row">
            <span data-slot="search-batch-query">{query}</span>
          </div>
        )}
      </For>
      <div data-slot="search-batch-spinner">
        <Spinner />
        <span>{_(SEARCH_TOOL_DESC.searching)}</span>
      </div>
    </div>
  )
}

function registerAnysearchTool(name: AnysearchToolName) {
  ToolRegistry.register({
    name,
    render(props: ToolProps) {
      if (name === "mcp__anysearch__batch_search") return renderBatchSearch(name, props)
      if (name === "mcp__anysearch__search") return renderSearch(name, props)
      return renderTextResult(name, props)
    },
  })
}

for (const name of ANYSEARCH_TOOL_NAMES) {
  registerAnysearchTool(name)
}
