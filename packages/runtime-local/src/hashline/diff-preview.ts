/**
 * Re-number a unified diff into a compact current-file preview.
 */
import type { CompactDiffOptions, CompactDiffPreview } from "./types"

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2

const PREVIEW_ELISION_MARKER = "…"
const PREVIEW_GAP_ROW = ""
const RAW_ELISION_MARKERS = new Set(["...", PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`])

function isPreviewSeparator(line: string | undefined): boolean {
  return line === PREVIEW_ELISION_MARKER || line === PREVIEW_GAP_ROW
}

function appendPreviewLine(output: string[], line: string): void {
  const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line
  if (isPreviewSeparator(normalized) && (output.length === 0 || isPreviewSeparator(output[output.length - 1]))) return
  output.push(normalized)
}

interface ParsedDiffLine {
  kind: "+" | "-" | " "
  lineNumber: number
  content: string
}

function normalizeAddedRunContext(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ADDED_RUN_CONTEXT_LINES
  return Math.max(1, Math.trunc(value))
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
  const kind = line[0]
  if (kind !== "+" && kind !== "-" && kind !== " ") return undefined
  const body = line.slice(1)
  const sep = body.indexOf("|")
  if (sep === -1) return undefined
  const lineNumber = Number.parseInt(body.slice(0, sep), 10)
  if (!Number.isFinite(lineNumber)) return undefined
  return { kind, lineNumber, content: body.slice(sep + 1) }
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
  if (run.length === 0) return
  const collapseThreshold = edgeLines * 2 + 1
  if (run.length <= collapseThreshold) {
    for (const text of run) appendPreviewLine(output, text)
    return
  }
  for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i])
  appendPreviewLine(output, PREVIEW_ELISION_MARKER)
  for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i])
}

export function buildCompactDiffPreview(diff: string, options: CompactDiffOptions = {}): CompactDiffPreview {
  const lines = diff.length === 0 ? [] : diff.split("\n")
  const addedRunContext = normalizeAddedRunContext(options.maxAddedRunContext ?? options.maxUnchangedRun)
  let addedLines = 0
  let removedLines = 0
  const formatted: string[] = []
  const addedRun: string[] = []

  const flushAddedRun = (): void => {
    appendAddedRun(formatted, addedRun, addedRunContext)
    addedRun.length = 0
  }

  for (const line of lines) {
    const parsed = parseNumberedDiffLine(line)
    if (!parsed) {
      flushAddedRun()
      appendPreviewLine(formatted, line)
      continue
    }
    switch (parsed.kind) {
      case "+":
        addedLines++
        addedRun.push(`${parsed.lineNumber}:${parsed.content}`)
        break
      case "-":
        flushAddedRun()
        removedLines++
        break
      default:
        flushAddedRun()
        const newLineNumber = parsed.lineNumber + addedLines - removedLines
        appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`)
        break
    }
  }
  flushAddedRun()
  while (formatted.length > 0 && isPreviewSeparator(formatted[formatted.length - 1])) formatted.pop()

  return { preview: formatted.join("\n"), addedLines, removedLines }
}
