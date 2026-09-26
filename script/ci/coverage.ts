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
import { executionBatches } from "../../packages/testing/script/run"

export async function verifyCoverage(root: string, evidenceRoot: string, plan: Plan, results: TaskResult[]) {
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
  for (const result of results) {
    const task = plan.tasks.find((task) => task.id === result.task)!
    const executed: string[] = []
    for (const report of result.reports) {
      const bytes = await verifyReport(evidenceRoot, report)
      if (task.kind === "suite" && report.kind === "timing") {
        const timing = JSON.parse(Buffer.from(bytes).toString()) as { files: string[]; exitCode: number }
        if (timing.exitCode !== 0 || !Array.isArray(timing.files))
          errors.push(`Failed or missing batch evidence: ${task.id}`)
        else executed.push(...timing.files)
      }
      if (report.kind !== "lcov") continue
      if (!report.package || !owners.includes(report.package)) throw new Error("Coverage report has an unplanned owner")
      batches.push(
        parseLcov(Buffer.from(bytes).toString()).map((record) => ({
          ...record,
          file: path.resolve(root, report.package!, record.file),
        })),
      )
    }
    if (task.kind === "suite") {
      const expected =
        task.partition === undefined
          ? task.files!
          : executionBatches(task.files!, path.join(root, task.package!), 4)
              .filter((batch) => batch.partition === task.partition)
              .flatMap((batch) => batch.files)
      if (executed.toSorted().join("\0") !== expected.toSorted().join("\0"))
        errors.push(`Incomplete or repeated test inventory: ${task.id}`)
    }
  }
  const merged = mergeLcov(batches)
  const verdicts = []
  for (const owner of owners) {
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
  return { errors, verdicts }
}
