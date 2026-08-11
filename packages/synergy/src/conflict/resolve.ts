import { detectConflicts, type ConflictLocation } from "./detect"
import { stripBom } from "../hashline/normalize"

type ConflictStyle = "merge" | "diff3"

export type ConflictResolution =
  | { conflict: number; strategy: "ours" | "theirs"; conflictStyle?: ConflictStyle }
  | {
      conflict: number
      strategy: "both"
      order?: "ours-theirs" | "theirs-ours"
      conflictStyle?: ConflictStyle
    }
  | { conflict: number; strategy: "custom"; content: string }

type SourceLine = {
  text: string
  ending: string
}

const BASE_MARKER = /^\|\|\|\|\|\|\|(?:\s+.*)?$/

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (character !== "\r" && character !== "\n") continue
    const ending = character === "\r" && content[index + 1] === "\n" ? "\r\n" : character
    lines.push({ text: content.slice(start, index), ending })
    if (ending === "\r\n") index++
    start = index + 1
  }
  if (start < content.length) lines.push({ text: content.slice(start), ending: "" })
  return lines
}

function joinLines(lines: readonly SourceLine[]): string {
  return lines.map((line) => `${line.text}${line.ending}`).join("")
}

function splitCustomReplacement(content: string, trailingEnding: string): SourceLine[] {
  if (content === "") return []
  const lines = splitLines(content)
  const last = lines.at(-1)
  if (last && last.ending === "") last.ending = trailingEnding
  return lines
}

function conflictSides(
  lines: SourceLine[],
  conflict: ConflictLocation,
  conflictNumber: number,
  style: ConflictStyle,
): { ours: SourceLine[]; theirs: SourceLine[] } {
  const startIndex = conflict.startLine - 1
  const separatorIndex = conflict.separatorLine - 1
  const endIndex = conflict.endLine - 1
  let oursEnd = separatorIndex
  if (style === "diff3") {
    const baseMarkers = lines
      .slice(startIndex + 1, separatorIndex)
      .map((line, index) => ({ index, matches: BASE_MARKER.test(line.text) }))
      .filter((entry) => entry.matches)
    if (baseMarkers.length !== 1) {
      throw new Error(
        `Conflict ${conflictNumber} declares diff3 format but does not contain exactly one diff3 base marker.`,
      )
    }
    oursEnd = startIndex + 1 + baseMarkers[0].index
  }
  return {
    ours: lines.slice(startIndex + 1, oursEnd),
    theirs: lines.slice(separatorIndex + 1, endIndex),
  }
}

function replacementFor(lines: SourceLine[], conflict: ConflictLocation, resolution: ConflictResolution): SourceLine[] {
  const endIndex = conflict.endLine - 1
  if (resolution.strategy === "custom") {
    return splitCustomReplacement(resolution.content, lines[endIndex]?.ending ?? "")
  }

  const sides = conflictSides(lines, conflict, resolution.conflict, resolution.conflictStyle ?? "merge")
  switch (resolution.strategy) {
    case "ours":
      return sides.ours
    case "theirs":
      return sides.theirs
    case "both":
      return resolution.order === "theirs-ours" ? [...sides.theirs, ...sides.ours] : [...sides.ours, ...sides.theirs]
  }
}

export function resolveAllConflicts(content: string, resolutions: readonly ConflictResolution[]): string {
  const report = detectConflicts(content)
  if (!report.hasConflicts) throw new Error("The file does not contain conflict markers to resolve.")
  if (resolutions.length !== report.conflicts.length) {
    throw new Error(
      `Resolve all ${report.conflicts.length} conflict blocks in one call by providing exactly one resolution for each conflict.`,
    )
  }

  const byConflict = new Map<number, ConflictResolution>()
  for (const resolution of resolutions) {
    if (byConflict.has(resolution.conflict)) {
      throw new Error(`Conflict ${resolution.conflict} has more than one resolution.`)
    }
    byConflict.set(resolution.conflict, resolution)
  }
  for (let conflict = 1; conflict <= report.conflicts.length; conflict++) {
    if (!byConflict.has(conflict)) throw new Error(`Missing resolution for conflict ${conflict}.`)
  }
  for (const conflict of byConflict.keys()) {
    if (conflict < 1 || conflict > report.conflicts.length) {
      throw new Error(`Conflict ${conflict} does not exist; this file has ${report.conflicts.length} conflict blocks.`)
    }
  }

  const { bom, text } = stripBom(content)
  const lines = splitLines(text)

  for (let index = report.conflicts.length - 1; index >= 0; index--) {
    const location = report.conflicts[index]
    const resolution = byConflict.get(index + 1)!
    lines.splice(
      location.startLine - 1,
      location.endLine - location.startLine + 1,
      ...replacementFor(lines, location, resolution),
    )
  }

  const resolved = `${bom}${joinLines(lines)}`
  if (detectConflicts(resolved).hasConflicts) {
    throw new Error("Conflict resolution must remove all complete conflict blocks from the file.")
  }
  return resolved
}
