import { createMemo, For, Show } from "solid-js"
import "./diff-preview.css"

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

export interface DiffPreviewProps {
  diff: ToolDiffPreviewFileDiff | undefined
  variant?: "tool" | "session" | "review"
}

export const TOOL_DIFF_PREVIEW_EMPTY_MESSAGE = "No text preview available."

export function classifyToolDiffLine(text: string): ToolDiffLineKind {
  if (text === "\\ No newline at end of file") return "note"
  if (text.startsWith("@@")) return "hunk"
  if (text.startsWith("Index:") || text.startsWith("diff --git")) return "header"
  if (/^(index|new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)\b/.test(text))
    return "header"
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
  return diff?.truncated ? "Preview truncated" : ""
}

export function DiffPreview(props: DiffPreviewProps) {
  const lines = createMemo(() => parseToolDiffPreview(props.diff?.preview))
  const summary = createMemo(() => formatToolDiffPreviewSummary(props.diff))
  const variant = () => props.variant ?? "tool"

  return (
    <div data-component="diff-preview" data-variant={variant()}>
      <Show keyed when={summary()}>
        {(text) => <div data-slot="diff-preview-summary">{text}</div>}
      </Show>
      <Show
        when={lines().length > 0}
        fallback={<div data-slot="diff-preview-empty">{TOOL_DIFF_PREVIEW_EMPTY_MESSAGE}</div>}
      >
        <pre data-slot="diff-preview-body" aria-label="File diff preview">
          <For each={lines()}>
            {(line) => (
              <span data-slot="diff-preview-line" data-kind={line.kind}>
                {line.text}
              </span>
            )}
          </For>
        </pre>
      </Show>
    </div>
  )
}

export function ToolDiffPreview(props: { diff: ToolDiffPreviewFileDiff | undefined }) {
  return (
    <div data-component="edit-content">
      <DiffPreview diff={props.diff} variant="tool" />
    </div>
  )
}
