import { createMemo, For, Show } from "solid-js"

export type ToolDiffLineKind = "add" | "delete" | "hunk" | "header" | "note" | "context"

export interface ToolDiffPreviewFileDiff {
  file?: string
  additions?: number
  deletions?: number
  preview?: string
  beforeBytes?: number
  afterBytes?: number
  truncated?: boolean
}

export interface ToolDiffPreviewLine {
  text: string
  kind: ToolDiffLineKind
}

export const TOOL_DIFF_PREVIEW_EMPTY_MESSAGE = "No text preview available."

export function classifyToolDiffLine(text: string): ToolDiffLineKind {
  if (text === "\\ No newline at end of file") return "note"
  if (text.startsWith("@@")) return "hunk"
  if (text.startsWith("Index:") || text.startsWith("diff --git")) return "header"
  if (/^(---|\+\+\+)(\s|$)/.test(text)) return "header"
  if (/^={3,}$/.test(text.trim())) return "header"
  if (text.startsWith("+")) return "add"
  if (text.startsWith("-")) return "delete"
  return "context"
}

export function parseToolDiffPreview(preview: string | undefined): ToolDiffPreviewLine[] {
  if (!preview) return []
  const text = preview.endsWith("\n") ? preview.slice(0, -1) : preview
  if (!text) return []
  return text.split("\n").map((line) => ({
    text: line,
    kind: classifyToolDiffLine(line),
  }))
}

export function formatToolDiffPreviewSummary(diff: ToolDiffPreviewFileDiff | undefined): string {
  const beforeBytes = diff?.beforeBytes ?? 0
  const afterBytes = diff?.afterBytes ?? 0
  return `${beforeBytes} bytes to ${afterBytes} bytes${diff?.truncated ? " - preview truncated" : ""}`
}

export function ToolDiffPreview(props: { diff: ToolDiffPreviewFileDiff | undefined }) {
  const lines = createMemo(() => parseToolDiffPreview(props.diff?.preview))

  return (
    <div data-component="edit-content">
      <div data-component="tool-diff-preview">
        <div data-slot="tool-diff-preview-summary">{formatToolDiffPreviewSummary(props.diff)}</div>
        <Show
          when={lines().length > 0}
          fallback={<div data-slot="tool-diff-preview-empty">{TOOL_DIFF_PREVIEW_EMPTY_MESSAGE}</div>}
        >
          <pre data-slot="tool-diff-preview-body" aria-label="File diff preview">
            <For each={lines()}>
              {(line) => (
                <span data-slot="tool-diff-preview-line" data-kind={line.kind}>
                  {line.text}
                </span>
              )}
            </For>
          </pre>
        </Show>
      </div>
    </div>
  )
}
