import { createMemo, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import type { ToolProps } from "../../tool-registry-lazy"
import {
  getScholightToolInfo,
  parseScholightPapers,
  SCHOLIGHT_TOOL_NAMES,
  type ScholightToolName,
} from "../scholight-info"
import { toolElapsedLabel, toolHostname, type ToolResultRow } from "../anysearch-info"
import { RawToolOutput, SearchResultRows, SearchSummary } from "./search-result-parts"
import { SEARCH_TOOL_DESC } from "../../tool-title-descriptors"

const TOP_PAPER_ROWS = 3

function triggerFromInfo(name: ScholightToolName, props: ToolProps) {
  const info = getScholightToolInfo(name, props.input ?? {})
  return {
    icon: info.icon,
    title: info.title,
    subtitle: info.subtitle || "",
    tags: info.args?.map((label) => ({ label })),
  }
}

/** B-card for search_papers: header + paper count strip (+ strength when
 * given) + up to three parsed top papers; plain text falls back to the
 * standard text output body. */
function ScholightSearchPapers(props: ToolProps) {
  const { _ } = useLingui()
  const papers = createMemo(() => parseScholightPapers(props.output))
  const meta = () => {
    const strength = typeof props.input?.strength === "string" ? props.input.strength.trim() : ""
    return strength === "standard" || strength === "thorough" ? strength : undefined
  }
  return (
    <BasicTool {...props} trigger={triggerFromInfo("mcp__scholight__search_papers", props)}>
      <SearchSummary
        rows={[
          papers() ? { label: _(SEARCH_TOOL_DESC.papers), value: `${papers()!.length} papers` } : undefined,
          meta() ? { label: _(SEARCH_TOOL_DESC.strength), value: meta() } : undefined,
          { label: _(SEARCH_TOOL_DESC.elapsed), value: toolElapsedLabel(props.time) },
        ]}
      />
      <Show when={papers()} fallback={<RawToolOutput output={props.output} />}>
        {(parsed) => <SearchResultRows rows={parsed() as ToolResultRow[]} limit={TOP_PAPER_ROWS} />}
      </Show>
    </BasicTool>
  )
}

/** B-card for extract_url: family header + host strip; the fetched text is
 * long-form, so it keeps the standard text output body. */
function ScholightExtractUrl(props: ToolProps) {
  const { _ } = useLingui()
  const host = () => toolHostname(props.input?.url)
  const format = () =>
    typeof props.input?.format === "string" && props.input.format.trim() ? props.input.format : undefined
  return (
    <BasicTool {...props} trigger={triggerFromInfo("mcp__scholight__extract_url", props)}>
      <SearchSummary
        rows={[
          host() ? { label: _(SEARCH_TOOL_DESC.host), value: host() } : undefined,
          format() ? { label: _(SEARCH_TOOL_DESC.format), value: format() } : undefined,
          { label: _(SEARCH_TOOL_DESC.elapsed), value: toolElapsedLabel(props.time) },
        ]}
      />
      <RawToolOutput output={props.output} />
    </BasicTool>
  )
}

function registerScholightTool(name: ScholightToolName) {
  ToolRegistry.register({
    name,
    render(props: ToolProps) {
      if (name === "mcp__scholight__search_papers") return <ScholightSearchPapers {...props} />
      return <ScholightExtractUrl {...props} />
    },
  })
}

for (const name of SCHOLIGHT_TOOL_NAMES) {
  registerScholightTool(name)
}
