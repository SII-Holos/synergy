import type { WorkspaceInput } from "./plan"
import type { CoverageChanges } from "./selection"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function same(left: unknown, right: unknown): boolean {
  if (record(left) && record(right)) {
    const keys = Object.keys(left).sort()
    return keys.join("\0") === Object.keys(right).sort().join("\0") && keys.every((key) => same(left[key], right[key]))
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

function exemptions(value: unknown): Map<string, string> | undefined {
  if (!Array.isArray(value)) return
  const result = new Map<string, string>()
  for (const entry of value) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join("\0") !== "glob\0reason" ||
      typeof entry.glob !== "string" ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      result.has(entry.glob)
    )
      return
    result.set(entry.glob, entry.reason)
  }
  return result
}

export function coverageChanges(
  base: unknown,
  head: unknown,
  baseWorkspaces: WorkspaceInput[],
  headWorkspaces: WorkspaceInput[],
): CoverageChanges {
  const invalid: CoverageChanges = { complete: false, packages: [], files: [] }
  if (
    !record(base) ||
    !record(head) ||
    Object.keys(base).join() !== "packages" ||
    Object.keys(head).join() !== "packages" ||
    !record(base.packages) ||
    !record(head.packages)
  )
    return invalid
  const owners = Object.keys(base.packages).sort()
  if (owners.join("\0") !== Object.keys(head.packages).sort().join("\0")) return invalid
  const packages: string[] = []
  const files: string[] = []
  for (const directory of owners) {
    if (![baseWorkspaces, headWorkspaces].every((entries) => entries.some((entry) => entry.directory === directory)))
      return invalid
    const before = base.packages[directory]
    const after = head.packages[directory]
    if (!record(before) || !record(after)) return invalid
    const allowed = ["command", "lcov", "thresholds", "exempt", "maxExemptShare"]
    if ([before, after].some((entry) => Object.keys(entry).some((key) => !allowed.includes(key)))) return invalid
    for (const entry of [before, after]) {
      if (
        typeof entry.command !== "string" ||
        !entry.command.trim() ||
        typeof entry.lcov !== "string" ||
        !entry.lcov.trim() ||
        !record(entry.thresholds) ||
        Object.keys(entry.thresholds).sort().join("\0") !== "functions\0lines" ||
        Object.values(entry.thresholds).some(
          (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100,
        ) ||
        (entry.maxExemptShare !== undefined &&
          (typeof entry.maxExemptShare !== "number" || !Number.isFinite(entry.maxExemptShare)))
      )
        return invalid
    }
    if (allowed.filter((key) => key !== "exempt").some((key) => !same(before[key], after[key]))) return invalid
    const previous = exemptions(before.exempt)
    const next = exemptions(after.exempt)
    if (!previous || !next) return invalid
    const changed = [...new Set([...previous.keys(), ...next.keys()])].filter(
      (file) => previous.get(file) !== next.get(file),
    )
    if (
      changed.some(
        (file) =>
          !/^src\/(?:[\w.-]+\/)*[\w.-]+\.tsx?$/.test(file) ||
          file.split("/").some((part) => part === "." || part === ".."),
      )
    )
      return invalid
    if (!changed.length) continue
    packages.push(directory)
    files.push(...changed.map((file) => `${directory}/${file}`))
  }
  return { complete: true, packages, files: files.sort() }
}
