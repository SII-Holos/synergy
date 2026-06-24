import { createMemo, For, Show } from "solid-js"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { ToolTextOutput } from "../tool-output-text"
import { DiagnosticsDisplay, getDiagnostics, getDirectory, type ToolProps } from "../message-part"

type RangeInfo = {
  startLine?: number
  endLine?: number
  offset?: number
  limit?: number
  truncated?: boolean
}

export function shortText(value: unknown, max = 42): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function lineRangeLabel(range: RangeInfo): string | undefined {
  const start = range.startLine ?? (range.offset != null ? range.offset + 1 : undefined)
  const end = range.endLine ?? (range.offset != null && range.limit != null ? range.offset + range.limit : undefined)
  if (start == null) return undefined
  return end != null && end >= start ? `L${start}-${end}` : `L${start}`
}

export function conflictCount(metadata: Record<string, any>): number {
  if (metadata.hasConflicts) return metadata.conflicts?.length || 1
  const conflicts = metadata.conflicts
  if (!conflicts || Array.isArray(conflicts)) return 0
  return Object.keys(conflicts).length
}

export function diagnosticCount(metadata: Record<string, any>): number {
  const diagnostics = metadata.diagnostics
  if (!diagnostics) return 0
  return Object.values(diagnostics as Record<string, any[]>).reduce(
    (sum, items) => sum + items.filter((item) => item?.severity === 1).length,
    0,
  )
}

export function changeSummary(props: ToolProps): { additions: number; deletions: number } | undefined {
  return (props.metadata?.changeSummary || props.metadata?.filediff) as any
}

export function operationCounts(operations: string[]): string[] {
  const counts = new Map<string, number>()
  for (const operation of operations) {
    const kind = operation.split(" ")[0]
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => `${kind} ${count}`)
}

function pathLabel(path: string): string {
  if (!path) return ""
  return getDirectory(path) + "/" + getFilename(path)
}

function fileRows(metadata: Record<string, any>) {
  return ((metadata.files ?? []) as string[]).slice(0, 8).map((file) => ({
    file,
    tag: metadata.tags?.[file],
    lines: metadata.matchLines?.[file] as number[] | undefined,
    ranges: metadata.matchRanges?.[file] as string[] | undefined,
  }))
}

// ── Exported components ──────────────────────────────────────────────

export function SummaryGrid(props: { rows: Array<{ label: string; value?: any } | undefined> }) {
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

export function WarningPanel(props: { metadata: Record<string, any> }) {
  const count = () => conflictCount(props.metadata)
  return (
    <Show when={count() > 0}>
      <div data-component="anchored-warning" data-tone="warning">
        <strong>Conflict markers detected</strong>
        <span>
          {count()} file or region{count() === 1 ? "" : "s"} may need resolution before anchored edits.
        </span>
      </div>
    </Show>
  )
}

export function DiagnosticsPanel(props: { diagnostics: Record<string, any[]> | undefined; path?: string }) {
  const diagnostics = createMemo(() => {
    const path = props.path
    const direct = getDiagnostics(props.diagnostics, path)
    if (direct.length > 0) return direct
    const all = Object.values(props.diagnostics ?? {}).flat() as any[]
    return all.filter((item) => item?.severity === 1).slice(0, 3)
  })
  return <DiagnosticsDisplay diagnostics={diagnostics()} />
}

export function RawOutput(props: { output?: string }) {
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

export function SearchFiles(props: { metadata: Record<string, any>; mode: "text" | "ast" }) {
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
                <Show when={row.tag}> · tag {row.tag}</Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
