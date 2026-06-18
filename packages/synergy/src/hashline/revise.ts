import type { PatchOp } from "./patch"
import { normalizeContent, splitContentLines } from "./tag"

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = normalizeContent(content)
  const trailingNewline = normalized.endsWith("\n")
  const lines = splitContentLines(normalized)
  return { lines, trailingNewline }
}

function joinContent(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? "\n" : ""
  return lines.join("\n") + (trailingNewline ? "\n" : "")
}

function assertLine(line: number, lineCount: number, label = "Line"): void {
  if (line < 1 || line > lineCount)
    throw new Error(`${label} ${line} is out of bounds for file with ${lineCount} lines`)
}

function assertRange(startLine: number, endLine: number, lineCount: number): void {
  assertLine(startLine, lineCount, "Start line")
  assertLine(endLine, lineCount, "End line")
  if (endLine < startLine) throw new Error(`Invalid range ${startLine}..${endLine}`)
}

/**
 * Strip boundary echo from a replace payload.
 */
function repairReplace(
  lines: string[],
  startLine: number,
  endLine: number,
  payload: string[],
): { startLine: number; endLine: number; lines: string[]; isNoop: boolean } {
  const originalSlice = lines.slice(startLine - 1, endLine)
  if (payload.length === originalSlice.length && payload.every((l, i) => l === originalSlice[i])) {
    return { startLine, endLine, lines: payload, isNoop: true }
  }

  let prefixStrip = 0
  while (
    prefixStrip < payload.length &&
    startLine - 1 + prefixStrip < endLine &&
    payload[prefixStrip] === lines[startLine - 1 + prefixStrip]
  ) {
    prefixStrip++
  }

  let suffixStrip = 0
  while (
    suffixStrip < payload.length - prefixStrip &&
    endLine - suffixStrip > startLine - 1 + prefixStrip &&
    payload[payload.length - 1 - suffixStrip] === lines[endLine - 1 - suffixStrip]
  ) {
    suffixStrip++
  }

  const narrowedLines = payload.slice(prefixStrip, payload.length - suffixStrip)
  const narrowedStart = startLine + prefixStrip
  const narrowedEnd = endLine - suffixStrip

  if (narrowedStart > narrowedEnd) {
    return { startLine, endLine, lines: payload, isNoop: true }
  }

  const narrowedOriginal = lines.slice(narrowedStart - 1, narrowedEnd)
  if (narrowedLines.length === narrowedOriginal.length && narrowedLines.every((l, i) => l === narrowedOriginal[i])) {
    return { startLine, endLine, lines: payload, isNoop: true }
  }

  return { startLine: narrowedStart, endLine: narrowedEnd, lines: narrowedLines, isNoop: false }
}

/**
 * Correct insert landing echo.
 */
function repairInsert(
  lines: string[],
  position: "before" | "after",
  lineNumber: number,
  payload: string[],
): { lines: string[] } {
  if (position === "before") {
    let strip = 0
    while (
      strip < payload.length &&
      lineNumber - 1 + strip < lines.length &&
      payload[strip] === lines[lineNumber - 1 + strip]
    ) {
      strip++
    }
    return { lines: payload.slice(strip) }
  }

  let strip = 0
  while (
    strip < payload.length &&
    lineNumber + strip < lines.length &&
    payload[payload.length - 1 - strip] === lines[lineNumber + strip]
  ) {
    strip++
  }
  return { lines: payload.slice(0, payload.length - strip) }
}

function isHeadNoop(lines: string[], payload: string[]): boolean {
  if (payload.length === 0) return true
  if (lines.length < payload.length) return false
  return payload.every((l, i) => lines[i] === l)
}

function isTailNoop(lines: string[], payload: string[]): boolean {
  if (payload.length === 0) return true
  if (lines.length < payload.length) return false
  return payload.every((l, i) => lines[lines.length - payload.length + i] === l)
}

export function applyPatchOps(content: string, ops: PatchOp[]): string {
  for (const op of ops) {
    if (op.type === "blockSwap") {
      throw new Error(
        "SWAP.BLK is not yet supported for direct file application. Use SWAP with explicit line numbers (call view_file first to get the target range), or use save_file for full-file replacement.",
      )
    }
  }
  const { lines, trailingNewline } = splitContent(content)
  const result = [...lines]

  const anchored = ops.filter((op) => !(op.type === "insert" && (op.position === "head" || op.position === "tail")))
  for (const op of [...anchored].reverse()) {
    if (op.type === "replace") {
      assertRange(op.startLine, op.endLine, result.length)
      const repaired = repairReplace(result, op.startLine, op.endLine, op.lines)
      if (!repaired.isNoop) {
        result.splice(repaired.startLine - 1, repaired.endLine - repaired.startLine + 1, ...repaired.lines)
      }
      continue
    }
    if (op.type === "delete") {
      assertRange(op.startLine, op.endLine, result.length)
      result.splice(op.startLine - 1, op.endLine - op.startLine + 1)
      continue
    }
    if (op.type !== "insert") continue
    if (op.position !== "before" && op.position !== "after") continue
    assertLine(op.lineNumber, result.length, "Insert anchor line")
    const repaired = repairInsert(result, op.position, op.lineNumber, op.lines)
    if (repaired.lines.length === 0) continue
    const index = op.position === "before" ? op.lineNumber - 1 : op.lineNumber
    result.splice(index, 0, ...repaired.lines)
  }

  for (const op of ops) {
    if (op.type !== "insert") continue
    if (op.position === "head") {
      if (!isHeadNoop(result, op.lines)) result.unshift(...op.lines)
    }
    if (op.position === "tail") {
      if (!isTailNoop(result, op.lines)) result.push(...op.lines)
    }
  }

  return joinContent(result, trailingNewline || ops.length > 0)
}
