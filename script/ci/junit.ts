import path from "node:path"
import { verifyReport, type TaskResult } from "./evidence"
import type { Plan } from "./plan"

interface ParsedCase {
  name: string
  outcome: "passed" | "skipped" | "failure" | "error"
}

interface ParsedReport {
  index: number
  cases: ParsedCase[]
  error?: string
}

function isCase(value: unknown): value is ParsedCase {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "outcome" in value &&
    typeof value.outcome === "string" &&
    ["passed", "skipped", "failure", "error"].includes(value.outcome)
  )
}

function isReport(value: unknown): value is ParsedReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "index" in value &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    "cases" in value &&
    Array.isArray(value.cases) &&
    value.cases.every(isCase) &&
    (!("error" in value) || typeof value.error === "string")
  )
}

export async function verifyScenarios(evidenceRoot: string, plan: Plan, results: TaskResult[]): Promise<string[]> {
  const errors: string[] = []
  const tasks = plan.tasks.filter((task) => plan.selected.includes(task.id) && task.scenarios !== undefined)
  const reports: Array<{ task: string; path: string; index: number; xml: string }> = []
  for (const task of tasks) {
    if (
      !task.scenarios!.length ||
      new Set(task.scenarios).size !== task.scenarios!.length ||
      task.scenarios!.some(
        (name) => !name || (task.scenarioPrefix !== undefined && !name.startsWith(task.scenarioPrefix)),
      )
    ) {
      errors.push(`Invalid scenario inventory: ${task.id}`)
    }
    const matches = results.filter((result) => result.task === task.id)
    if (matches.length !== 1) {
      errors.push(`Missing or duplicate scenario result: ${task.id}`)
      continue
    }
    for (const report of matches[0]!.reports.filter((report) => report.kind === "junit")) {
      try {
        const bytes = await verifyReport(evidenceRoot, report)
        reports.push({
          task: task.id,
          path: report.path,
          index: reports.length,
          xml: Buffer.from(bytes).toString("base64"),
        })
      } catch (error) {
        errors.push(`Invalid JUnit report for ${task.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (!tasks.length) return errors
  const observed = new Map<string, Array<{ name: string; outcome: string }>>()
  if (reports.length) {
    try {
      const child = Bun.spawn(["python3", path.join(import.meta.dir, "junit.py")], {
        stdin: new TextEncoder().encode(JSON.stringify(reports.map(({ index, xml }) => ({ index, xml })))),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`JUnit parser exited ${code}: ${stderr.trim()}`)
      const parsed: unknown = JSON.parse(stdout)
      if (!Array.isArray(parsed) || !parsed.every(isReport)) throw new Error("Invalid JUnit parser response")
      if (parsed.length !== reports.length || new Set(parsed.map((report) => report.index)).size !== reports.length)
        throw new Error("JUnit parser returned an incomplete report inventory")
      for (const entry of parsed) {
        const report = reports[entry.index]
        if (!report) throw new Error("JUnit parser returned an unknown report")
        if (entry.error) {
          errors.push(`Malformed JUnit report ${report.path}: ${entry.error}`)
          continue
        }
        const cases = observed.get(report.task) ?? []
        cases.push(...entry.cases)
        observed.set(report.task, cases)
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const task of tasks) {
    const cases = observed.get(task.id) ?? []
    for (const name of task.scenarios!) {
      const matches = cases.filter((entry) => entry.name === name)
      if (!matches.length) errors.push(`Missing scenario: ${task.id}: ${name}`)
      else if (matches.length !== 1) errors.push(`Duplicate scenario: ${task.id}: ${name}`)
      else if (matches[0]!.outcome !== "passed")
        errors.push(`Scenario did not pass: ${task.id}: ${name}: ${matches[0]!.outcome}`)
    }
    if (task.scenarioPrefix !== undefined)
      for (const entry of cases)
        if (entry.name.startsWith(task.scenarioPrefix) && !task.scenarios!.includes(entry.name))
          errors.push(`Unplanned scenario: ${task.id}: ${entry.name}`)
  }
  return errors
}
