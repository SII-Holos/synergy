import type { PatchOp } from "./patch"

const MAX_CONTEXT_RADIUS = 5

export interface RecoveryResult {
  ops: PatchOp[]
  mode: "three-way-merge"
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

function contextMatches(
  snapshotLines: string[],
  liveLines: string[],
  candidateStart: number,
  startLine: number,
  endLine: number,
  radius: number,
): boolean {
  const targetLength = endLine - startLine + 1

  for (let distance = 1; distance <= radius; distance++) {
    const before = snapshotLines[startLine - 1 - distance]
    if (before !== undefined && liveLines[candidateStart - distance] !== before) return false

    const after = snapshotLines[endLine - 1 + distance]
    if (after !== undefined && liveLines[candidateStart + targetLength - 1 + distance] !== after) return false
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

  for (let radius = 1; radius <= MAX_CONTEXT_RADIUS; radius++) {
    const contextualMatches = matches.filter((index) =>
      contextMatches(snapshotLines, liveLines, index, startLine, endLine, radius),
    )
    if (contextualMatches.length === 1) return contextualMatches[0] + 1
  }

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

  return { ops: recovered, mode: "three-way-merge" }
}
