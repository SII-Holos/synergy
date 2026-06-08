import type { PatchOp } from "./patch"
import { normalizeContent } from "./tag"

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = normalizeContent(content)
  const trailingNewline = normalized.endsWith("\n")
  if (normalized === "") return { lines: [], trailingNewline }
  const body = trailingNewline ? normalized.slice(0, -1) : normalized
  return { lines: body === "" ? [] : body.split("\n"), trailingNewline }
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

export function applyPatchOps(content: string, ops: PatchOp[]): string {
  const { lines, trailingNewline } = splitContent(content)
  const result = [...lines]

  const anchored = ops.filter((op) => !(op.type === "insert" && (op.position === "head" || op.position === "tail")))
  for (const op of [...anchored].reverse()) {
    if (op.type === "replace") {
      assertRange(op.startLine, op.endLine, result.length)
      result.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...op.lines)
      continue
    }
    if (op.type === "delete") {
      assertRange(op.startLine, op.endLine, result.length)
      result.splice(op.startLine - 1, op.endLine - op.startLine + 1)
      continue
    }
    if (op.position !== "before" && op.position !== "after") continue
    assertLine(op.lineNumber, result.length, "Insert anchor line")
    const index = op.position === "before" ? op.lineNumber - 1 : op.lineNumber
    result.splice(index, 0, ...op.lines)
  }

  for (const op of ops) {
    if (op.type !== "insert") continue
    if (op.position === "head") result.unshift(...op.lines)
    if (op.position === "tail") result.push(...op.lines)
  }

  return joinContent(result, trailingNewline || ops.length > 0)
}
