import { hash, type Plan } from "./plan"
import { type TaskResult } from "./evidence"

export interface ShadowEvidence {
  version: 1
  policy: string
  run: string
  sha: string
  base: string
  mode: string
  passed: boolean
  changed: string[]
  misses: string[]
  taskSeconds: number
  selectedSeconds: number
}

export function shadowEvidence(plan: Plan, results: TaskResult[], passed: boolean, policy: string): ShadowEvidence {
  const seconds = (result: TaskResult) => (Date.parse(result.completed) - Date.parse(result.started)) / 1000
  return {
    version: 1,
    policy,
    run: plan.run,
    sha: plan.sha,
    base: plan.base,
    mode: plan.mode,
    passed,
    changed: plan.changed,
    misses: results
      .filter((result) => result.status !== "success" && !plan.proposed.includes(result.task))
      .map((result) => result.task),
    taskSeconds: results.reduce((sum, result) => sum + seconds(result), 0),
    selectedSeconds: results
      .filter((result) => plan.proposed.includes(result.task))
      .reduce((sum, result) => sum + seconds(result), 0),
  }
}

export function rolloutErrors(evidence: ShadowEvidence[], policy: string): string[] {
  const errors: string[] = []
  const samples = evidence.filter(
    (sample) => sample.version === 1 && sample.policy === policy && ["full", "shadow"].includes(sample.mode),
  )
  if (samples.some((sample) => sample.misses.length > 0)) errors.push("Shadow execution found unselected failures")
  const unique = [
    ...new Map(
      samples.filter((sample) => sample.passed && sample.misses.length === 0).map((sample) => [sample.sha, sample]),
    ).values(),
  ]
  if (new Set(unique.map((sample) => sample.run)).size < 20)
    errors.push("Affected admission requires 20 successful full runs on distinct commits")
  for (const [name, pattern] of Object.entries({
    docs: /^docs\//,
    frontend: /^(?:apps\/web|packages\/ui)\//,
    runtime: /^packages\/(?:harness|runtime-local)\//,
    benchmark: /^benchmark\//,
    tooling: /^(?:script|test|\.github|packages\/testing)\//,
  })) {
    if (!unique.some((sample) => sample.changed.some((file) => pattern.test(file))))
      errors.push(`Shadow evidence lacks ${name} changes`)
  }
  return errors
}

export function policyIdentity(sources: string[]): string {
  return hash(sources)
}
