import type { PatchOp } from "./patch"

export interface RecoveryResult {
  ops: PatchOp[]
  mode: "drift-before-target"
}

class RecoveryFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecoveryFailure"
  }
}

function splitLines(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function matchesAt(lines: string[], candidateStart: number, needle: string[]): boolean {
  if (candidateStart < 0 || candidateStart + needle.length > lines.length) return false
  for (let index = 0; index < needle.length; index++) {
    if (lines[candidateStart + index] !== needle[index]) return false
  }
  return true
}

function locateUniqueRange(snapshotLines: string[], liveLines: string[], startLine: number, endLine: number): number {
  const needle = snapshotLines.slice(startLine - 1, endLine)
  if (needle.length === 0) throw new RecoveryFailure("cannot recover empty target range")

  const matches: number[] = []
  for (let index = 0; index <= liveLines.length - needle.length; index++) {
    if (matchesAt(liveLines, index, needle)) matches.push(index)
  }

  if (matches.length === 0) throw new RecoveryFailure("target content changed; cannot recover safely")
  if (matches.length === 1) return matches[0] + 1

  const previousLine = snapshotLines[startLine - 2]
  const nextLine = snapshotLines[endLine]
  const contextualMatches = matches.filter((index) => {
    if (previousLine !== undefined && liveLines[index - 1] !== previousLine) return false
    if (nextLine !== undefined && liveLines[index + needle.length] !== nextLine) return false
    return true
  })

  if (contextualMatches.length === 1) return contextualMatches[0] + 1
  throw new RecoveryFailure("ambiguous recovery target; multiple matches cannot be disambiguated")
}

export function recoverPatchOps(snapshotContent: string, liveContent: string, ops: PatchOp[]): RecoveryResult {
  const snapshotLines = splitLines(snapshotContent)
  const liveLines = splitLines(liveContent)
  const recovered: PatchOp[] = []

  for (const op of ops) {
    if (op.type === "replace") {
      const startLine = locateUniqueRange(snapshotLines, liveLines, op.startLine, op.endLine)
      recovered.push({ ...op, startLine, endLine: startLine + (op.endLine - op.startLine) })
      continue
    }

    if (op.type === "delete") {
      const startLine = locateUniqueRange(snapshotLines, liveLines, op.startLine, op.endLine)
      recovered.push({ ...op, startLine, endLine: startLine + (op.endLine - op.startLine) })
      continue
    }

    if (op.position === "before" || op.position === "after") {
      const lineNumber = locateUniqueRange(snapshotLines, liveLines, op.lineNumber, op.lineNumber)
      recovered.push({ ...op, lineNumber })
      continue
    }

    recovered.push(op)
  }

  return { ops: recovered, mode: "drift-before-target" }
}
