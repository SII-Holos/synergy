import { detectConflicts, type ConflictLocation } from "./detect"
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../hashline/normalize"

export type ConflictResolution =
  | { conflict: number; strategy: "ours" | "theirs" }
  | { conflict: number; strategy: "both"; order?: "ours-theirs" | "theirs-ours" }
  | { conflict: number; strategy: "custom"; content: string }

const BASE_MARKER = /^\|\|\|\|\|\|\|(?:\s+.*)?$/
const ANY_CONFLICT_MARKER = /^(?:<<<<<<<(?:\s+.*)?|\|\|\|\|\|\|\|(?:\s+.*)?|=======(?:\s*)|>>>>>>>(?:\s+.*)?)$/m

function splitReplacement(content: string): string[] {
  if (content === "") return []
  const lines = normalizeToLF(content).split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function conflictSides(lines: string[], conflict: ConflictLocation): { ours: string[]; theirs: string[] } {
  const startIndex = conflict.startLine - 1
  const separatorIndex = conflict.separatorLine - 1
  const endIndex = conflict.endLine - 1
  const baseOffset = lines.slice(startIndex + 1, separatorIndex).findIndex((line) => BASE_MARKER.test(line))
  const oursEnd = baseOffset === -1 ? separatorIndex : startIndex + 1 + baseOffset
  return {
    ours: lines.slice(startIndex + 1, oursEnd),
    theirs: lines.slice(separatorIndex + 1, endIndex),
  }
}

function replacementFor(lines: string[], conflict: ConflictLocation, resolution: ConflictResolution): string[] {
  const sides = conflictSides(lines, conflict)
  switch (resolution.strategy) {
    case "ours":
      return sides.ours
    case "theirs":
      return sides.theirs
    case "both":
      return resolution.order === "theirs-ours" ? [...sides.theirs, ...sides.ours] : [...sides.ours, ...sides.theirs]
    case "custom":
      if (ANY_CONFLICT_MARKER.test(normalizeToLF(resolution.content))) {
        throw new Error(`Custom resolution for conflict ${resolution.conflict} must not contain conflict marker lines.`)
      }
      return splitReplacement(resolution.content)
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
  const lineEnding = detectLineEnding(text)
  const lines = normalizeToLF(text).split("\n")

  for (let index = report.conflicts.length - 1; index >= 0; index--) {
    const location = report.conflicts[index]
    const resolution = byConflict.get(index + 1)!
    lines.splice(
      location.startLine - 1,
      location.endLine - location.startLine + 1,
      ...replacementFor(lines, location, resolution),
    )
  }

  const resolved = `${bom}${restoreLineEndings(lines.join("\n"), lineEnding)}`
  if (detectConflicts(resolved).hasConflicts || ANY_CONFLICT_MARKER.test(normalizeToLF(resolved))) {
    throw new Error("Conflict resolution must remove all conflict marker lines from the file.")
  }
  return resolved
}
