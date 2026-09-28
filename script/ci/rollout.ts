import { hash, type Plan } from "./plan"
import { type TaskResult } from "./evidence"

export interface ShadowEvidence {
  version: 1
  policy: string
  catalog: string
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
    catalog: hash(plan.tasks),
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

export function policyIdentity(sources: string[]): string {
  return hash(sources)
}
