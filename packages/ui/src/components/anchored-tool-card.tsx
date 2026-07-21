import { ANCHORED_CHIP_DESC } from "./tool-title-descriptors"

import { createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useCodeComponent } from "../context/code"
import { BasicTool } from "./basic-tool"
import { ToolTextOutput } from "./tool-output-text"
import { DiagnosticsDisplay, getDiagnostics, getDirectory, type ToolProps } from "./message-part"
import { ToolDiffPreview, type ToolDiffPreviewFileDiff } from "./tool/diff-preview"
import { hasSaveFileContentInput, saveFilePreviewDiff } from "./tool/save-file-preview"

type FileDiff = ToolDiffPreviewFileDiff

type RangeInfo = {
  startLine?: number
  endLine?: number
  offset?: number
  limit?: number
  truncated?: boolean
}

// i18n descriptors for anchored tool cards
const viewFileTitleDescriptor = { id: "ui.anchoredTool.viewFile", message: "View File" }
const scanFilesTitleDescriptor = { id: "ui.anchoredTool.scanFiles", message: "Scan Files" }
const parseCodeTitleDescriptor = { id: "ui.anchoredTool.parseCode", message: "Parse Code" }
const reviseFileTitleDescriptor = { id: "ui.anchoredTool.reviseFile", message: "Revise File" }
const saveFileTitleDescriptor = { id: "ui.anchoredTool.saveFile", message: "Save File" }
const ANCHORED_TAG_HEX_DESC = { id: "ui.anchoredTool.tagLabel", message: "tag" }
const createFileTitleDescriptor = { id: "ui.anchoredTool.createFile", message: "Create File" }
const currentScopeDescriptor = { id: "ui.anchoredTool.currentScope", message: "Current scope" }
const fromStartDescriptor = { id: "ui.anchoredTool.fromStart", message: "from start" }
const overwriteExistingDescriptor = { id: "ui.anchoredTool.overwriteExisting", message: "Overwrite existing file" }
const createNewFileDescriptor = { id: "ui.anchoredTool.createNewFile", message: "Create new file" }
const conflictMarkersDescriptor = { id: "ui.anchoredTool.conflictMarkers", message: "Conflict markers detected" }
const conflictResolutionHintDescriptor = {
  id: "ui.anchoredTool.conflictResolutionHint",
  message: "{count} file or region{pluralSuffix} may need resolution before precise edits.",
}

const summaryLabelFileDescriptor = { id: "ui.anchoredTool.summary.file", message: "File" }
const summaryLabelDisplayedDescriptor = { id: "ui.anchoredTool.summary.displayed", message: "Displayed" }
const summaryLabelTotalDescriptor = { id: "ui.anchoredTool.summary.total", message: "Total" }
const summaryLabelTagDescriptor = { id: "ui.anchoredTool.summary.tag", message: "Tag" }
const summaryLabelPatternDescriptor = { id: "ui.anchoredTool.summary.pattern", message: "Pattern" }
const summaryLabelRegexDescriptor = { id: "ui.anchoredTool.summary.regex", message: "Regex" }
const summaryLabelSearchPathDescriptor = { id: "ui.anchoredTool.summary.searchPath", message: "Search path" }
const summaryLabelFilterDescriptor = { id: "ui.anchoredTool.summary.filter", message: "Filter" }
const summaryLabelResultDescriptor = { id: "ui.anchoredTool.summary.result", message: "Result" }
const summaryLabelModeDescriptor = { id: "ui.anchoredTool.summary.mode", message: "Mode" }
const summaryLabelOperationsDescriptor = { id: "ui.anchoredTool.summary.operations", message: "Operations" }
const summaryLabelRecoveryDescriptor = { id: "ui.anchoredTool.summary.recovery", message: "Recovery" }
const recoverySafelyMappedDescriptor = {
  id: "ui.anchoredTool.recovery.safelyMapped",
  message: "Safely mapped onto the current file",
}

function pathFromProps(props: ToolProps): string {
  const headerPath = typeof props.input.input === "string" ? props.input.input.match(/^\[([^#\]]+)/)?.[1] : undefined
  const paths = Array.isArray(props.input.paths) ? props.input.paths.join(", ") : undefined
  return (props.metadata?.path ||
    props.metadata?.filepath ||
    props.input.filePath ||
    props.input.path ||
    paths ||
    headerPath ||
    "") as string
}

function pathLabel(path: string): string {
  if (!path) return ""
  return getDirectory(path) + "/" + getFilename(path)
}

function shortText(value: unknown, max = 42): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function lineRangeLabel(range: RangeInfo): string | undefined {
  const start = range.startLine ?? (range.offset != null ? range.offset + 1 : undefined)
  const end = range.endLine ?? (range.offset != null && range.limit != null ? range.offset + range.limit : undefined)
  if (start == null) return undefined
  return end != null && end >= start ? `L${start}-${end}` : `L${start}`
}

function conflictCount(metadata: Record<string, any>): number {
  if (metadata.hasConflicts) return metadata.conflicts?.length || 1
  const conflicts = metadata.conflicts
  if (!conflicts || Array.isArray(conflicts)) return 0
  return Object.keys(conflicts).length
}

function diagnosticCount(metadata: Record<string, any>): number {
  const diagnostics = metadata.diagnostics
  if (!diagnostics) return 0
  return Object.values(diagnostics as Record<string, any[]>).reduce(
    (sum, items) => sum + items.filter((item) => item?.severity === 1).length,
    0,
  )
}

function changeSummary(props: ToolProps): { additions: number; deletions: number } | undefined {
  return (props.metadata?.changeSummary || props.metadata?.filediff) as any
}

function SummaryGrid(props: { rows: Array<{ label: string; value?: any } | undefined> }) {
  const { _ } = useLingui()
  const rows = () =>
    props.rows.filter((row) => row && row.value !== undefined && row.value !== "") as Array<{
      label: string
      value: any
    }>
  return (
    <Show when={rows().length > 0}>
      <div data-component="anchored-summary">
        <For each={rows()}>
          {(row) => (
            <div data-slot="anchored-summary-row">
              <span data-slot="anchored-summary-label">{row.label}</span>
              <span data-slot="anchored-summary-value">{row.value}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function WarningPanel(props: { metadata: Record<string, any> }) {
  const { _ } = useLingui()
  const count = () => conflictCount(props.metadata)
  return (
    <Show when={count() > 0}>
      <div data-component="anchored-warning" data-tone="warning">
        <strong>{_(conflictMarkersDescriptor)}</strong>
        <span>
          {_({
            ...conflictResolutionHintDescriptor,
            values: { count: count(), pluralSuffix: count() === 1 ? "" : "s" },
          })}
        </span>
      </div>
    </Show>
  )
}

function DiagnosticsPanel(props: { diagnostics: Record<string, any[]> | undefined; path?: string }) {
  const diagnostics = createMemo(() => {
    const path = props.path
    const direct = getDiagnostics(props.diagnostics, path)
    if (direct.length > 0) return direct
    const all = Object.values(props.diagnostics ?? {}).flat() as any[]
    return all.filter((item) => item?.severity === 1).slice(0, 3)
  })
  return <DiagnosticsDisplay diagnostics={diagnostics()} />
}

function RawOutput(props: { output?: string }) {
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

function fileRows(metadata: Record<string, any>) {
  return ((metadata.files ?? []) as string[]).slice(0, 8).map((file) => ({
    file,
    tag: metadata.tags?.[file],
    lines: metadata.matchLines?.[file] as number[] | undefined,
    ranges: metadata.matchRanges?.[file] as string[] | undefined,
  }))
}

function SearchFiles(props: { metadata: Record<string, any>; mode: "text" | "ast" }) {
  const { _ } = useLingui()
  const rows = () => fileRows(props.metadata)
  return (
    <Show when={rows().length > 0}>
      <div data-component="anchored-file-list">
        <For each={rows()}>
          {(row) => (
            <div data-slot="anchored-file-row">
              <span data-slot="anchored-file-path">{pathLabel(row.file)}</span>
              <span data-slot="anchored-file-meta">
                {props.mode === "ast" ? row.ranges?.slice(0, 3).join(", ") : row.lines?.slice(0, 6).join(", ")}
                <Show when={row.tag}>
                  {" "}
                  · {_(ANCHORED_TAG_HEX_DESC)} {row.tag}
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function operationCounts(operations: string[]): string[] {
  const counts = new Map<string, number>()
  for (const operation of operations) {
    const kind = operation.split(" ")[0]
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => `${kind} ${count}`)
}

export function AnchoredViewTool(props: ToolProps) {
  const { _ } = useLingui()
  const ranges = () => (props.metadata?.ranges ?? []) as RangeInfo[]
  const primaryRange = () => {
    if (ranges().length > 0) return undefined
    if (props.metadata?.offset == null && props.metadata?.limit == null) return undefined
    return lineRangeLabel({ offset: props.metadata.offset, limit: props.metadata.limit })
  }
  const rangeLabels = () => ranges().map(lineRangeLabel).filter(Boolean) as string[]
  const chips = () => [
    ...rangeLabels()
      .slice(0, 2)
      .map((label) => ({ label })),
    primaryRange() ? { label: primaryRange()! } : undefined,
    ranges().length > 2 ? { label: `+${ranges().length - 2} ranges` } : undefined,
    props.metadata?.tag ? { label: _(ANCHORED_CHIP_DESC.tag) + " " + props.metadata.tag } : undefined,
    conflictCount(props.metadata) > 0 ? { label: _(ANCHORED_CHIP_DESC.conflict), tone: "warning" as const } : undefined,
  ]
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: "scan-eye",
        title: _(viewFileTitleDescriptor),
        subtitlePath: pathFromProps(props),
        tags: chips().filter(Boolean) as Array<{ label: string; tone?: "default" | "success" | "warning" | "danger" }>,
      }}
    >
      <WarningPanel metadata={props.metadata} />
      <SummaryGrid
        rows={[
          { label: _(summaryLabelFileDescriptor), value: pathLabel(pathFromProps(props)) },
          {
            label: _(summaryLabelDisplayedDescriptor),
            value: rangeLabels().join(" · ") || primaryRange() || _(fromStartDescriptor),
          },
          {
            label: _(summaryLabelTotalDescriptor),
            value: props.metadata?.totalLines != null ? `${props.metadata.totalLines} lines` : undefined,
          },
          { label: _(summaryLabelTagDescriptor), value: props.metadata?.tag },
        ]}
      />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

export function AnchoredSearchTool(props: ToolProps & { mode: "text" | "ast" }) {
  const { _ } = useLingui()
  const files = () => ((props.metadata?.files ?? []) as string[]).length
  const matches = () => props.metadata?.matches as number | undefined
  const title = () => _(props.mode === "ast" ? parseCodeTitleDescriptor : scanFilesTitleDescriptor)
  const subtitle = () => shortText(props.input.pattern, 60)
  const searchPath = () =>
    props.input.path || (Array.isArray(props.input.paths) ? props.input.paths.join(", ") : undefined)
  const chips = () => [
    props.mode === "ast" && props.input.lang ? { label: props.input.lang as string } : undefined,
    matches() != null ? { label: `${matches()} match${matches() === 1 ? "" : "es"}` } : undefined,
    { label: `${files()} file${files() === 1 ? "" : "s"}` },
    props.input.include ? { label: props.input.include as string } : undefined,
    conflictCount(props.metadata) > 0
      ? { label: _(ANCHORED_CHIP_DESC.conflict) + " " + conflictCount(props.metadata), tone: "warning" as const }
      : undefined,
  ]
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: props.mode === "ast" ? "braces" : "scan-search",
        title: title(),
        subtitle: subtitle(),
        tags: chips().filter(Boolean) as Array<{ label: string; tone?: "default" | "success" | "warning" | "danger" }>,
      }}
    >
      <WarningPanel metadata={props.metadata} />
      <SummaryGrid
        rows={[
          {
            label: _(props.mode === "ast" ? summaryLabelPatternDescriptor : summaryLabelRegexDescriptor),
            value: props.input.pattern,
          },
          { label: _(summaryLabelSearchPathDescriptor), value: searchPath() || _(currentScopeDescriptor) },
          {
            label: _(summaryLabelFilterDescriptor),
            value: props.input.include || (props.input.globs ?? []).join(", "),
          },
          {
            label: _(summaryLabelResultDescriptor),
            value: `${matches() ?? 0} match${matches() === 1 ? "" : "es"} across ${files()} file${files() === 1 ? "" : "s"}`,
          },
        ]}
      />
      <SearchFiles metadata={props.metadata} mode={props.mode} />
      <RawOutput output={props.output} />
    </BasicTool>
  )
}

export function AnchoredScanFilesTool(props: ToolProps) {
  return <AnchoredSearchTool {...props} mode="text" />
}

export function AnchoredParseCodeTool(props: ToolProps) {
  return <AnchoredSearchTool {...props} mode="ast" />
}

export function AnchoredReviseTool(props: ToolProps) {
  const { _ } = useLingui()
  const filePath = () => pathFromProps(props)
  const filediff = () => props.metadata?.filediff as FileDiff | undefined
  const operations = () => (props.metadata?.operationSummary ?? []) as string[]
  const diagnostics = () => diagnosticCount(props.metadata)
  const chips = () => [
    ...operationCounts(operations())
      .slice(0, 3)
      .map((label) => ({ label })),
    props.metadata?.recovered ? { label: _(ANCHORED_CHIP_DESC.recovered), tone: "success" as const } : undefined,
    diagnostics() > 0 ? { label: `diagnostics ${diagnostics()}`, tone: "danger" as const } : undefined,
  ]
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: "file-pen",
        title: _(reviseFileTitleDescriptor),
        subtitlePath: filePath(),
        tags: chips().filter(Boolean) as Array<{ label: string; tone?: "default" | "success" | "warning" | "danger" }>,
        changes: changeSummary(props),
      }}
    >
      <WarningPanel metadata={props.metadata} />
      <SummaryGrid
        rows={[
          { label: _(summaryLabelOperationsDescriptor), value: operations().join(" · ") },
          props.metadata?.recovered
            ? { label: _(summaryLabelRecoveryDescriptor), value: _(recoverySafelyMappedDescriptor) }
            : undefined,
        ]}
      />
      <DiagnosticsPanel diagnostics={props.metadata?.diagnostics} path={props.metadata?.filepath || filePath()} />
      <Show when={filediff()} fallback={<RawOutput output={props.output} />}>
        {(diff) => <ToolDiffPreview diff={diff()} />}
      </Show>
    </BasicTool>
  )
}

export function AnchoredSaveTool(props: ToolProps) {
  const { _ } = useLingui()
  const codeComponent = useCodeComponent()
  const filePath = () => pathFromProps(props)
  const content = () => (props.input.content ?? "") as string
  const isOverwrite = () => props.metadata?.exists === true
  const diagnostics = () => diagnosticCount(props.metadata)
  const chips = () => [
    props.metadata?.tag ? { label: _(ANCHORED_CHIP_DESC.tag) + " " + props.metadata.tag } : undefined,
    diagnostics() > 0 ? { label: `diagnostics ${diagnostics()}`, tone: "danger" as const } : undefined,
    props.metadata?.previousHasConflicts
      ? { label: _(ANCHORED_CHIP_DESC.resolvedConflict), tone: "warning" as const }
      : undefined,
  ]
  const saveDiff = () => saveFilePreviewDiff(props)
  const hasContentInput = () => hasSaveFileContentInput(props)
  return (
    <BasicTool
      {...props}
      trigger={{
        icon: "text-select",
        title: _(isOverwrite() ? saveFileTitleDescriptor : createFileTitleDescriptor),
        subtitlePath: filePath(),
        tags: chips().filter(Boolean) as Array<{ label: string; tone?: "default" | "success" | "warning" | "danger" }>,
        changes: changeSummary(props),
      }}
    >
      <WarningPanel metadata={props.metadata} />
      <SummaryGrid
        rows={[
          {
            label: _(summaryLabelModeDescriptor),
            value: _(isOverwrite() ? overwriteExistingDescriptor : createNewFileDescriptor),
          },
        ]}
      />
      <DiagnosticsPanel diagnostics={props.metadata?.diagnostics} path={props.metadata?.filepath || filePath()} />
      <Show
        when={saveDiff()}
        fallback={
          <Show when={hasContentInput()} fallback={<RawOutput output={props.output} />}>
            <div data-component="write-content">
              <Dynamic
                component={codeComponent}
                file={{ name: filePath() || "file", contents: content(), cacheKey: checksum(content()) }}
                overflow="scroll"
              />
            </div>
          </Show>
        }
      >
        {(diff) => <ToolDiffPreview diff={diff()} />}
      </Show>
    </BasicTool>
  )
}
export { SummaryGrid, WarningPanel, DiagnosticsPanel, RawOutput, SearchFiles } from "./tool/body-primitives"
export {
  shortText,
  lineRangeLabel,
  conflictCount,
  diagnosticCount,
  changeSummary,
  operationCounts,
} from "./tool/body-primitives"
