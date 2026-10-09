import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Plan } from "./plan"
import type { TaskResult } from "./evidence"

interface Sample {
  id: string
  completed: string
  seconds: number
}
interface TimingSeries {
  owner: string
  kind: "browser" | "isolated" | "shared" | "task"
  files?: string[]
  samples: Sample[]
}
export interface Timings {
  version: 1
  profiles: Record<string, Record<string, TimingSeries>>
}
type Kind = TimingSeries["kind"]
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function fields(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}
function sampleValue(value: unknown): Sample {
  if (
    !object(value) ||
    !fields(value, ["id", "completed", "seconds"]) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.completed !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.completed) ||
    !Number.isFinite(Date.parse(value.completed)) ||
    typeof value.seconds !== "number" ||
    !Number.isFinite(value.seconds) ||
    value.seconds <= 0
  )
    throw new Error("Invalid CI timing sample")
  return { id: value.id, completed: value.completed, seconds: value.seconds }
}
function seriesValue(value: unknown): TimingSeries {
  if (
    !object(value) ||
    !fields(value, ["owner", "kind", "files", "samples"]) ||
    typeof value.owner !== "string" ||
    !value.owner ||
    (value.kind !== "task" && value.kind !== "browser" && value.kind !== "isolated" && value.kind !== "shared") ||
    !Array.isArray(value.samples) ||
    !value.samples.length ||
    value.samples.length > 10
  )
    throw new Error("Invalid CI timing series")
  const files = value.files
  if (
    value.kind === "task"
      ? files !== undefined
      : !Array.isArray(files) ||
        !files.length ||
        files.some((file) => typeof file !== "string" || !file) ||
        new Set(files).size !== files.length
  )
    throw new Error("Invalid CI timing batch files")
  return {
    owner: value.owner,
    kind: value.kind,
    ...(Array.isArray(files) ? { files } : {}),
    samples: value.samples.map(sampleValue),
  }
}
export function validateTimings(value: unknown): Timings {
  if (!object(value) || !fields(value, ["version", "profiles"]) || value.version !== 1 || !object(value.profiles))
    throw new Error("Invalid CI timing snapshot")
  const profiles: Timings["profiles"] = {}
  for (const [profile, entries] of Object.entries(value.profiles)) {
    if (!object(entries)) throw new Error("Invalid CI timing profile")
    profiles[profile] = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, seriesValue(value)]))
  }
  return { version: 1, profiles }
}
export function timingProfile(platform: string = process.platform, arch: string = process.arch, bun = Bun.version) {
  return `${platform}/${arch}/bun-${bun}`
}
export function batchKey(owner: string, files: string[]) {
  return `batch:${createHash("sha256")
    .update(JSON.stringify([owner, files.toSorted()]))
    .digest("hex")}`
}
export function batchKind(files: string[], root: string): Kind {
  if (files.length > 1) return "shared"
  const pending = [path.join(root, files[0]!)]
  const visited = new Set<string>()
  const testRoot = path.join(root, "test") + path.sep
  for (const file of pending) {
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, "utf8")
    if (/["'](?:@playwright\/test|playwright(?:-core)?)["']/.test(source)) return "browser"
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(file), match[1]!)
      if (!target.startsWith(testRoot)) continue
      const resolved = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js", ""]
        .map((extension) => target + extension)
        .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile())
      if (resolved) pending.push(resolved)
    }
  }
  return "isolated"
}
function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
}

function recentEstimate(series: TimingSeries) {
  const samples = series.samples
    .toSorted((a, b) => a.completed.localeCompare(b.completed) || a.id.localeCompare(b.id))
    .slice(-5)
  return Math.max(samples.at(-1)!.seconds, median(samples.map((sample) => sample.seconds)))
}
export function recordTiming(
  timings: Timings,
  profile: string,
  key: string,
  value: Omit<TimingSeries, "samples"> & { sample: TimingSeries["samples"][number] },
) {
  const sample = sampleValue(value.sample)
  const entries = (timings.profiles[profile] ??= {})
  const previous = entries[key]
  const samples = [...(previous?.samples ?? []).filter((entry) => entry.id !== sample.id), sample]
    .sort((a, b) => a.completed.localeCompare(b.completed) || a.id.localeCompare(b.id))
    .slice(-10)
  entries[key] = seriesValue({ owner: value.owner, kind: value.kind, files: value.files?.toSorted(), samples })
}
export function estimateTask(timings: Timings, profile: string, id: string) {
  const series = timings.profiles[profile]?.[`task:${id}`]
  return series ? recentEstimate(series) : undefined
}
export function estimateBatch(timings: Timings, profile: string, owner: string, files: string[], kind: Kind) {
  const entries = timings.profiles[profile] ?? {}
  const known = entries[batchKey(owner, files)]
  if (known) return recentEstimate(known)
  const comparable = Object.values(entries).filter((entry) => entry.kind === kind)
  const local = comparable.filter((entry) => entry.owner === owner)
  const candidates = (local.length ? local : comparable)
    .map((entry) => recentEstimate(entry) / (kind === "shared" ? entry.files!.length : 1))
    .sort((a, b) => a - b)
  const fallback = kind === "browser" ? 30 : kind === "isolated" ? 10 : 2
  return (candidates[Math.ceil((candidates.length - 1) * 0.75)] ?? fallback) * (kind === "shared" ? files.length : 1)
}

export async function collectTimings(
  timings: Timings,
  root: string,
  reportsRoot: string,
  plan: Plan,
  results: TaskResult[],
) {
  const output = structuredClone(timings)
  for (const result of results) {
    if (result.status !== "success" || !result.runtime) continue
    const profile = timingProfile(result.runtime.platform, result.runtime.arch, result.runtime.bun)
    const task = plan.tasks.find((task) => task.id === result.task)!
    const id = `${result.run}/${result.executionAttempt}/${result.task}`
    const seconds = (Date.parse(result.completed) - Date.parse(result.started)) / 1000
    if (seconds > 0)
      recordTiming(output, profile, `task:${task.id}`, {
        owner: task.package ?? task.id,
        kind: "task",
        sample: { id, completed: result.completed, seconds },
      })
    if (!task.package) continue
    for (const report of result.reports.filter((report) => report.kind === "timing")) {
      const batch = (await Bun.file(path.join(reportsRoot, report.path)).json()) as {
        files: string[]
        seconds: number
        exitCode: number
      }
      if (batch.exitCode || batch.seconds <= 0) continue
      const key = batchKey(task.package, batch.files)
      recordTiming(output, profile, key, {
        owner: task.package,
        files: batch.files,
        kind: batchKind(batch.files, path.join(root, task.package)),
        sample: { id: `${id}/${key}`, completed: result.completed, seconds: batch.seconds },
      })
    }
  }
  return validateTimings(output)
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string", multiple: true },
      output: { type: "string" },
    },
  })
  if (!values.input?.length || !values.output)
    throw new Error(
      "Usage: bun script/ci/timing.ts --input snapshot.json [--input snapshot.json] --output timings.json",
    )
  const output: Timings = { version: 1, profiles: {} }
  for (const file of values.input) {
    const snapshot = validateTimings(await Bun.file(file).json())
    for (const [profile, entries] of Object.entries(snapshot.profiles))
      for (const [key, entry] of Object.entries(entries))
        for (const sample of entry.samples) recordTiming(output, profile, key, { ...entry, sample })
  }
  await Bun.write(values.output, JSON.stringify(output, null, 2) + "\n")
}
