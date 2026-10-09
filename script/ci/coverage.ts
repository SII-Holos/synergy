import path from "node:path"
import {
  evaluatePackage,
  loadManifest,
  mergeLcov,
  parseLcov,
  sourceUniverse,
  validateManifest,
} from "../coverage-check"
import { verifyReport, type TaskResult } from "./evidence"
import { type Plan } from "./plan"

export async function verifyCoverage(
  root: string,
  evidenceRoot: string,
  plan: Plan,
  results: TaskResult[],
  options: { diagnostic?: boolean } = {},
) {
  const manifest = await loadManifest(root)
  const errors = await validateManifest(manifest, root)
  const owners = [
    ...new Set(
      plan.tasks
        .filter((task) => plan.selected.includes(task.id) && task.kind === "suite")
        .map((task) => task.package!),
    ),
  ].sort()
  const batches = []
  const accepted = new Set<string>()
  for (const result of results) {
    const task = plan.tasks.find((task) => task.id === result.task)
    if (
      !task ||
      !plan.selected.includes(result.task) ||
      result.plan !== plan.digest ||
      result.sha !== plan.sha ||
      result.run !== plan.run ||
      result.planAttempt !== plan.attempt ||
      result.status !== "success" ||
      result.exitCode !== 0
    ) {
      errors.push(`Invalid coverage execution: ${result.task}`)
      continue
    }
    const executed: string[] = []
    const collected = []
    const priorErrors = errors.length
    for (const report of result.reports) {
      try {
        const bytes = await verifyReport(evidenceRoot, report)
        if (task.kind === "suite" && report.kind === "timing") {
          const timing = JSON.parse(Buffer.from(bytes).toString()) as { files: string[]; exitCode: number }
          if (timing.exitCode !== 0 || !Array.isArray(timing.files))
            errors.push(`Failed or missing batch evidence: ${task.id}`)
          else executed.push(...timing.files)
        }
        if (report.kind !== "lcov") continue
        if (!report.package || !owners.includes(report.package))
          throw new Error("Coverage report has an unplanned owner")
        collected.push(
          parseLcov(Buffer.from(bytes).toString()).map((record) => ({
            ...record,
            file: path.resolve(root, report.package!, record.file),
          })),
        )
      } catch (error) {
        if (!options.diagnostic) throw error
        errors.push(`Invalid coverage report for ${task.id}: ${String(error)}`)
      }
    }
    if (task.kind === "suite") {
      const expected = task.files!
      if (executed.toSorted().join("\0") !== expected.toSorted().join("\0"))
        errors.push(`Incomplete or repeated test inventory: ${task.id}`)
    }
    if (errors.length === priorErrors) {
      accepted.add(task.id)
      batches.push(...collected)
    }
  }
  const merged = mergeLcov(batches)
  const verdicts = []
  const incomplete: string[] = []
  for (const owner of owners) {
    if (
      options.diagnostic &&
      plan.tasks.some(
        (task) =>
          plan.selected.includes(task.id) &&
          task.package === owner &&
          (task.kind === "suite" || task.outputs?.includes("lcov")) &&
          !accepted.has(task.id),
      )
    ) {
      incomplete.push(owner)
      errors.push(`Incomplete coverage evidence: ${owner}`)
      continue
    }
    const config = manifest.packages[owner]
    if (!config) throw new Error(`Missing coverage policy: ${owner}`)
    const directory = path.join(root, owner)
    const universe = await sourceUniverse(directory, ["src/**/*.ts", "src/**/*.tsx"])
    const verdict = evaluatePackage(
      owner,
      config,
      universe,
      merged.map((record) => ({ ...record, file: path.relative(directory, record.file).split(path.sep).join("/") })),
    )
    verdicts.push(verdict)
    if (!verdict.passed)
      errors.push(
        `${owner}: lines ${verdict.linesPct.toFixed(1)}%, functions ${verdict.functionsPct.toFixed(1)}%, missing ${verdict.missing}`,
      )
  }
  return { errors, verdicts, incomplete }
}
