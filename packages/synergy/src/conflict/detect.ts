export interface ConflictLocation {
  startLine: number
  separatorLine: number
  endLine: number
}

export interface ConflictReport {
  hasConflicts: boolean
  conflicts: ConflictLocation[]
}

const START_MARKER = /^<<<<<<<(?:\s+.*)?$/
const SEPARATOR_MARKER = /^=======(?:\s*)$/
const END_MARKER = /^>>>>>>>(?:\s+.*)?$/

type ScanState =
  | { type: "idle" }
  | { type: "started"; startLine: number }
  | { type: "separated"; startLine: number; separatorLine: number }

export function detectConflicts(content: string): ConflictReport {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const conflicts: ConflictLocation[] = []
  let state: ScanState = { type: "idle" }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1

    if (START_MARKER.test(line)) {
      state = { type: "started", startLine: lineNumber }
      continue
    }

    if (SEPARATOR_MARKER.test(line)) {
      if (state.type === "started") {
        state = { type: "separated", startLine: state.startLine, separatorLine: lineNumber }
        continue
      }
      state = { type: "idle" }
      continue
    }

    if (END_MARKER.test(line)) {
      if (state.type === "separated") {
        conflicts.push({
          startLine: state.startLine,
          separatorLine: state.separatorLine,
          endLine: lineNumber,
        })
      }
      state = { type: "idle" }
    }
  }

  return { hasConflicts: conflicts.length > 0, conflicts }
}

export function conflictWarning(report: ConflictReport): string {
  if (!report.hasConflicts) return ""
  const ranges = report.conflicts.map((conflict) => `${conflict.startLine}-${conflict.endLine}`).join(", ")
  return `[CONFLICT WARNING]\nThis file contains unresolved merge conflict markers at lines ${ranges}. Do not use revise_file until conflicts are resolved. Use save_file only for an intentional full-file resolution.`
}
