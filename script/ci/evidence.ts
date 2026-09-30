import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { validatePlan, type Mode, type Plan } from "./plan"
import { filesIn } from "./artifacts"

export interface Report {
  path: string
  sha256: string
  kind: "lcov" | "junit" | "timing"
  package?: string
}
export interface TaskResult {
  version: 2
  task: string
  unit: string
  plan: string
  sha: string
  run: string
  planAttempt: string
  executionAttempt: string
  mode: Mode
  status: "success" | "failure"
  exitCode: number
  started: string
  completed: string
  reports: Report[]
  steps: Array<{ name: string; seconds: number; exitCode: number }>
}

export interface UnitExecution {
  unit: string
  attempt: string
  status: string
  conclusion: string | null
}

export async function readResults(root: string): Promise<TaskResult[]> {
  const results: TaskResult[] = []
  for (const file of (await filesIn(root)).filter((file) => file.endsWith("/result.json"))) {
    const result = JSON.parse(await readFile(file, "utf8")) as TaskResult
    const directory = path
      .relative(root, path.dirname(path.dirname(file)))
      .split(path.sep)
      .join("/")
    if (directory && directory !== `ci-results-${result.unit}-${result.executionAttempt}`)
      throw new Error(`Result artifact identity changed: ${result.task}`)
    results.push({
      ...result,
      reports: result.reports.map((report) => ({
        ...report,
        path: directory ? path.posix.join(directory, report.path) : report.path,
      })),
    })
  }
  return results
}

function taskUnit(plan: Plan, task: string): string | undefined {
  return (
    plan.units.find((unit) => unit.tasks.includes(task))?.id ??
    (task === "benchmark-prepare" && plan.selected.includes(task) ? task : undefined)
  )
}

export function latestResults(plan: Plan, results: TaskResult[], executions?: UnitExecution[]): TaskResult[] {
  const attempts = new Map(executions?.map((execution) => [execution.unit, execution.attempt]))
  return results.filter(
    (result) =>
      result.planAttempt === plan.attempt &&
      result.executionAttempt === (executions ? attempts.get(taskUnit(plan, result.task) ?? "") : plan.attempt),
  )
}

export function verifyResults(
  plan: Plan,
  history: TaskResult[],
  jobs: string[],
  executions?: UnitExecution[],
): string[] {
  validatePlan(plan)
  const errors: string[] = []
  if (plan.mode === "diagnostic") errors.push("Diagnostic execution cannot satisfy the required check")
  if (!jobs.length || jobs.some((state) => state !== "success"))
    errors.push("Required execution jobs did not all succeed")
  const attempts = new Map(executions?.map((execution) => [execution.unit, execution.attempt]))
  const units = new Set([
    ...plan.units.map((unit) => unit.id),
    ...(plan.selected.includes("benchmark-prepare") ? ["benchmark-prepare"] : []),
  ])
  if (executions)
    for (const unit of units) {
      const matches = executions.filter((execution) => execution.unit === unit)
      if (matches.length !== 1 || matches[0]!.status !== "completed" || matches[0]!.conclusion !== "success")
        errors.push(`Latest execution failed or missing: ${unit}`)
    }
  const receipts = new Set<string>()
  for (const result of history) {
    const sameRun = result.run === plan.run && result.sha === plan.sha
    if (
      sameRun &&
      result.version === 2 &&
      /^[1-9]\d*$/.test(result.planAttempt) &&
      /^[1-9]\d*$/.test(result.executionAttempt) &&
      Number(result.planAttempt) < Number(plan.attempt) &&
      Number(result.executionAttempt) < Number(plan.attempt)
    )
      continue
    const receipt = `${result.task}/${result.planAttempt}/${result.executionAttempt}`
    if (receipts.has(receipt)) errors.push(`Duplicate result: ${result.task}`)
    receipts.add(receipt)
    const unit = taskUnit(plan, result.task)
    if (
      !unit ||
      result.unit !== unit ||
      result.version !== 2 ||
      !sameRun ||
      result.plan !== plan.digest ||
      result.planAttempt !== plan.attempt ||
      result.mode !== plan.mode ||
      !/^[1-9]\d*$/.test(result.executionAttempt) ||
      Number(result.executionAttempt) < Number(plan.attempt) ||
      Number(result.executionAttempt) > Number(executions ? attempts.get(unit ?? "") : plan.attempt)
    )
      errors.push(`Foreign or stale result: ${result.task}`)
  }
  const results = latestResults(plan, history, executions)
  const seen = new Set<string>()
  for (const result of results) {
    if (!plan.selected.includes(result.task)) errors.push(`Unplanned result: ${result.task}`)
    if (seen.has(result.task)) errors.push(`Duplicate result: ${result.task}`)
    seen.add(result.task)
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
