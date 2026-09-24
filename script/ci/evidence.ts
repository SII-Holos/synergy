import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { validatePlan, type Mode, type Plan } from "./plan"

export interface Report {
  path: string
  sha256: string
  kind: "lcov" | "junit" | "timing"
  package?: string
}
export interface TaskResult {
  version: 1
  task: string
  plan: string
  sha: string
  run: string
  attempt: string
  mode: Mode
  status: "success" | "failure"
  exitCode: number
  started: string
  completed: string
  reports: Report[]
  steps: Array<{ name: string; seconds: number; exitCode: number }>
}

export function verifyResults(plan: Plan, results: TaskResult[], jobs: string[]): string[] {
  validatePlan(plan)
  const errors: string[] = []
  if (plan.mode === "diagnostic") errors.push("Diagnostic execution cannot satisfy the required check")
  if (!jobs.length || jobs.some((state) => state !== "success"))
    errors.push("Required execution jobs did not all succeed")
  const seen = new Set<string>()
  for (const result of results) {
    if (!plan.selected.includes(result.task)) errors.push(`Unplanned result: ${result.task}`)
    if (seen.has(result.task)) errors.push(`Duplicate result: ${result.task}`)
    seen.add(result.task)
    if (
      result.version !== 1 ||
      result.plan !== plan.digest ||
      result.sha !== plan.sha ||
      result.run !== plan.run ||
      result.attempt !== plan.attempt ||
      result.mode !== plan.mode
    ) {
      errors.push(`Foreign or stale result: ${result.task}`)
    }
    if (result.status !== "success" || result.exitCode !== 0) errors.push(`Failed task: ${result.task}`)
    if (
      !Number.isFinite(Date.parse(result.started)) ||
      !Number.isFinite(Date.parse(result.completed)) ||
      Date.parse(result.completed) < Date.parse(result.started)
    ) {
      errors.push(`Invalid task timing: ${result.task}`)
    }
    const task = plan.tasks.find((entry) => entry.id === result.task)
    for (const kind of task?.outputs ?? [])
      if (!result.reports.some((report) => report.kind === kind))
        errors.push(`Missing ${kind} evidence: ${result.task}`)
    if (
      task?.kind === "suite" &&
      (!result.reports.some((report) => report.kind === "lcov" && report.package === task.package) ||
        !result.reports.some((report) => report.kind === "junit"))
    ) {
      errors.push(`Missing test evidence: ${result.task}`)
    }
    if (
      !result.steps.length ||
      result.steps.some((step) => step.exitCode !== 0 || !Number.isFinite(step.seconds) || step.seconds < 0)
    )
      errors.push(`Missing or failed step: ${result.task}`)
  }
  for (const id of plan.selected) if (!seen.has(id)) errors.push(`Missing task: ${id}`)
  return errors
}

export async function verifyReport(root: string, report: Report): Promise<Uint8Array> {
  const resolved = path.resolve(root, report.path)
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("Report escapes CI evidence directory")
  if (!(await realpath(resolved)).startsWith((await realpath(root)) + path.sep))
    throw new Error("Report symlink escapes CI evidence directory")
  const bytes = await readFile(resolved)
  if (createHash("sha256").update(bytes).digest("hex") !== report.sha256)
    throw new Error(`Report checksum changed: ${report.path}`)
  return bytes
}
