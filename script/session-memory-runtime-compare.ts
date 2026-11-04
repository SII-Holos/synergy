#!/usr/bin/env bun

const MiB = 1024 * 1024

export const SESSION_MEMORY_COMPARE_METRICS = [
  "rssBytes",
  "processTreeRssBytes",
  "descendantRssBytes",
  "heapUsedBytes",
  "externalBytes",
  "arrayBuffersBytes",
] as const

export type SessionMemoryCompareMetric = (typeof SESSION_MEMORY_COMPARE_METRICS)[number]

export const DEFAULT_SESSION_MEMORY_COMPARE_LIMITS: Record<SessionMemoryCompareMetric, number> = {
  rssBytes: 64 * MiB,
  processTreeRssBytes: 96 * MiB,
  descendantRssBytes: 64 * MiB,
  heapUsedBytes: 32 * MiB,
  externalBytes: 32 * MiB,
  arrayBuffersBytes: 16 * MiB,
}

export const SESSION_MEMORY_RELEASE_LABELS = ["release-plus-5s", "release-plus-30s", "release-plus-120s"] as const

const AFTER_DELETE = /^run-(\d+)-after-delete$/
const LIMIT_FLAGS: Record<string, SessionMemoryCompareMetric> = {
  "--max-rss-mib": "rssBytes",
  "--max-process-tree-rss-mib": "processTreeRssBytes",
  "--max-descendant-rss-mib": "descendantRssBytes",
  "--max-heap-mib": "heapUsedBytes",
  "--max-external-mib": "externalBytes",
  "--max-array-buffers-mib": "arrayBuffersBytes",
}

const USAGE = `Usage: bun run perf:memory:runtime:compare --baseline <result.json> --candidate <result.json>
       [--max-rss-mib N] [--max-process-tree-rss-mib N] [--max-descendant-rss-mib N]
       [--max-heap-mib N] [--max-external-mib N] [--max-array-buffers-mib N]

Compare sequential perf:memory:runtime JSON. Exit 1 when candidate idle-relative
memory after the final deletion, or at 5/30/120s, exceeds the baseline by more than the limit.`

export interface SessionMemoryCompareCheck {
  checkpoint: "after-delete" | "idle-relative"
  label: string
  metric: SessionMemoryCompareMetric
  baselineBytes: number
  candidateBytes: number
  deltaBytes: number
  limitBytes: number
  pass: boolean
}

export interface SessionMemoryCompareIdentity {
  scenario: string
  contractVersion: number
  fingerprint: string
}

export interface SessionMemoryCompareReport {
  ok: boolean
  baseline: SessionMemoryCompareIdentity
  candidate: SessionMemoryCompareIdentity
  limits: Record<SessionMemoryCompareMetric, number>
  checks: SessionMemoryCompareCheck[]
  blocked?: string
}

type MemoryDelta = Record<SessionMemoryCompareMetric, number>

export function compareSessionMemoryResults(
  baselineInput: unknown,
  candidateInput: unknown,
  overrides: Partial<Record<SessionMemoryCompareMetric, number>> = {},
): SessionMemoryCompareReport {
  const limits = { ...DEFAULT_SESSION_MEMORY_COMPARE_LIMITS, ...overrides }
  for (const metric of SESSION_MEMORY_COMPARE_METRICS) {
    if (!Number.isFinite(limits[metric]) || limits[metric] < 0)
      throw new Error(`${metric} limit must be a finite non-negative number of bytes`)
  }
  const baselineResult = unwrap(baselineInput, "baseline")
  const candidateResult = unwrap(candidateInput, "candidate")
  const baseline = identity(baselineResult, "baseline")
  const candidate = identity(candidateResult, "candidate")
  const blocked = incomparable(baseline, candidate)
  if (blocked) return blockedReport(baseline, candidate, limits, blocked)

  const baselineSamples = checkpoints(baselineResult, "baseline")
  const candidateSamples = checkpoints(candidateResult, "candidate")
  const baselineDelete = finalAfterDelete(baselineSamples)
  const candidateDelete = finalAfterDelete(candidateSamples)
  if (!baselineDelete || !candidateDelete) {
    const side = baselineDelete ? "candidate" : "baseline"
    return blockedReport(baseline, candidate, limits, `${side} omitted the final after-delete checkpoint`)
  }
  if (baselineDelete.label !== candidateDelete.label) {
    return blockedReport(
      baseline,
      candidate,
      limits,
      `final after-delete checkpoint differs: baseline ${baselineDelete.label} candidate ${candidateDelete.label}`,
    )
  }

  const checks = [
    ...metricChecks("after-delete", baselineDelete.label, baselineDelete.delta, candidateDelete.delta, limits),
  ]
  for (const label of SESSION_MEMORY_RELEASE_LABELS) {
    const baselineDelta = baselineSamples.get(label)
    const candidateDelta = candidateSamples.get(label)
    if (!baselineDelta || !candidateDelta) {
      const side = baselineDelta ? "candidate" : "baseline"
      return blockedReport(baseline, candidate, limits, `${side} omitted ${label}`)
    }
    checks.push(...metricChecks("idle-relative", label, baselineDelta, candidateDelta, limits))
  }
  return { ok: checks.every((check) => check.pass), baseline, candidate, limits, checks }
}

export function parseCompareArguments(argv: string[]) {
  const limits: Partial<Record<SessionMemoryCompareMetric, number>> = {}
  let baseline: string | undefined
  let candidate: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    const metric = LIMIT_FLAGS[token]
    if (token !== "--baseline" && token !== "--candidate" && metric === undefined) {
      throw new Error(`Unknown argument ${token}\n${USAGE}`)
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value\n${USAGE}`)
    if (token === "--baseline") baseline = value
    else if (token === "--candidate") candidate = value
    else if (metric) {
      const bytes = Math.round(Number(value) * MiB)
      if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(bytes))
        throw new Error(`${token} must be a finite non-negative number of MiB`)
      limits[metric] = bytes
    }
  }
  if (!baseline || !candidate) throw new Error(USAGE)
  return { baseline, candidate, limits }
}

function blockedReport(
  baseline: SessionMemoryCompareIdentity,
  candidate: SessionMemoryCompareIdentity,
  limits: Record<SessionMemoryCompareMetric, number>,
  blocked: string,
): SessionMemoryCompareReport {
  return { ok: false, baseline, candidate, limits, checks: [], blocked }
}

function incomparable(baseline: SessionMemoryCompareIdentity, candidate: SessionMemoryCompareIdentity) {
  if (baseline.scenario !== "sequential" || candidate.scenario !== "sequential") {
    return `sequential results required, received baseline ${baseline.scenario} and candidate ${candidate.scenario}`
  }
  if (baseline.contractVersion !== candidate.contractVersion) {
    return `workload contract mismatch: baseline ${baseline.contractVersion} candidate ${candidate.contractVersion}`
  }
  if (baseline.fingerprint !== candidate.fingerprint) {
    return `workload fingerprint mismatch: baseline ${baseline.fingerprint} candidate ${candidate.fingerprint}`
  }
  return undefined
}

function metricChecks(
  checkpoint: SessionMemoryCompareCheck["checkpoint"],
  label: string,
  baselineDelta: MemoryDelta,
  candidateDelta: MemoryDelta,
  limits: Record<SessionMemoryCompareMetric, number>,
): SessionMemoryCompareCheck[] {
  return SESSION_MEMORY_COMPARE_METRICS.map((metric) => {
    const baselineBytes = metricValue(baselineDelta, metric)
    const candidateBytes = metricValue(candidateDelta, metric)
    const deltaBytes = candidateBytes - baselineBytes
    const limitBytes = metricValue(limits, metric)
    return {
      checkpoint,
      label,
      metric,
      baselineBytes,
      candidateBytes,
      deltaBytes,
      limitBytes,
      pass: deltaBytes <= limitBytes,
    }
  })
}

function unwrap(value: unknown, side: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${side} runtime result is not an object`)
  if (value.harness === "synergy-session-runtime-memory-suite") {
    if (!Array.isArray(value.scenarios)) throw new Error(`${side} suite omitted scenarios`)
    const match = value.scenarios.find(
      (item): item is Record<string, unknown> => isRecord(item) && item.scenario === "sequential",
    )
    if (!match) throw new Error(`${side} suite omitted the sequential scenario`)
    return match
  }
  if (value.harness !== "synergy-session-runtime-memory") {
    throw new Error(`${side} harness is not synergy-session-runtime-memory`)
  }
  return value
}

function identity(record: Record<string, unknown>, side: string): SessionMemoryCompareIdentity {
  if (typeof record.scenario !== "string" || record.scenario.length === 0) throw new Error(`${side} omitted scenario`)
  if (!isRecord(record.workload)) throw new Error(`${side} omitted workload`)
  const { contractVersion, fingerprint } = record.workload
  if (typeof contractVersion !== "number" || !Number.isInteger(contractVersion)) {
    throw new Error(`${side} omitted workload contractVersion`)
  }
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error(`${side} omitted workload fingerprint`)
  }
  return { scenario: record.scenario, contractVersion, fingerprint }
}

function checkpoints(record: Record<string, unknown>, side: string) {
  if (!Array.isArray(record.samples)) throw new Error(`${side} omitted samples`)
  const found = new Map<string, MemoryDelta>()
  for (const sample of record.samples) {
    if (!isRecord(sample) || typeof sample.label !== "string") throw new Error(`${side} sample omitted label`)
    if (!isCheckpoint(sample.label)) continue
    if (found.has(sample.label)) throw new Error(`${side} duplicated checkpoint ${sample.label}`)
    found.set(sample.label, deltaFrom(sample, sample.label))
  }
  return found
}

function isCheckpoint(label: string) {
  return AFTER_DELETE.test(label) || SESSION_MEMORY_RELEASE_LABELS.some((release) => release === label)
}

function finalAfterDelete(samples: Map<string, MemoryDelta>) {
  const matched = [...samples.keys()]
    .flatMap((label) => {
      const match = AFTER_DELETE.exec(label)
      return match ? [{ label, index: Number(match[1]) }] : []
    })
    .sort((left, right) => left.index - right.index)
  const final = matched.at(-1)
  const delta = final ? samples.get(final.label) : undefined
  return final && delta ? { label: final.label, delta } : undefined
}

function metricValue(values: MemoryDelta, metric: SessionMemoryCompareMetric) {
  const value = values[metric]
  if (typeof value !== "number") throw new Error(`missing ${metric}`)
  return value
}

function deltaFrom(sample: Record<string, unknown>, label: string): MemoryDelta {
  if (!isRecord(sample.deltaFromIdle)) throw new Error(`sample ${label} omitted deltaFromIdle`)
  const values = {} as MemoryDelta
  for (const metric of SESSION_MEMORY_COMPARE_METRICS) {
    const value = sample.deltaFromIdle[metric]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`sample ${label} omitted finite deltaFromIdle.${metric}`)
    }
    values[metric] = value
  }
  return values
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  let args: ReturnType<typeof parseCompareArguments>
  try {
    args = parseCompareArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  let report: SessionMemoryCompareReport
  try {
    const [baseline, candidate] = await Promise.all([Bun.file(args.baseline).json(), Bun.file(args.candidate).json()])
    report = compareSessionMemoryResults(baseline, candidate, args.limits)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.ok) return
  if (report.blocked) console.error(report.blocked)
  for (const check of report.checks) {
    if (check.pass) continue
    console.error(
      `${check.checkpoint} ${check.label} ${check.metric} grew ${check.deltaBytes} bytes above baseline, limit ${check.limitBytes}`,
    )
  }
  process.exitCode = 1
}

if (import.meta.main) await main()
