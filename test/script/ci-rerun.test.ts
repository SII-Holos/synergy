import { expect, test } from "bun:test"
import { createPlan } from "../../script/ci/plan"
import { readResults, verifyReport, verifyResults, type TaskResult, type UnitExecution } from "../../script/ci/evidence"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const plan = createPlan({
  base: "a".repeat(40),
  head: "b".repeat(40),
  sha: "c".repeat(40),
  run: "42",
  attempt: "1",
  mode: "full",
  changed: [],
  baseWorkspaces: [],
  headWorkspaces: [],
  tasks: ["first", "second"].map((id) => ({
    id,
    kind: "postgres" as const,
    pool: "postgres" as const,
    owners: [],
    needs: [],
    seconds: 1,
  })),
})

function result(task: string, executionAttempt: string): TaskResult {
  return {
    version: 2,
    task,
    unit: task,
    plan: plan.digest,
    sha: plan.sha,
    run: plan.run,
    planAttempt: plan.attempt,
    executionAttempt,
    mode: plan.mode,
    status: "success",
    exitCode: 0,
    started: "2026-09-30T00:00:00Z",
    completed: "2026-09-30T00:00:01Z",
    reports: [],
    steps: [{ name: task, seconds: 1, exitCode: 0 }],
  }
}

const jobs: UnitExecution[] = [
  { unit: "first", attempt: "1", status: "completed", conclusion: "success" },
  { unit: "second", attempt: "2", status: "completed", conclusion: "success" },
]

test("a failed-job rerun combines the original successful unit with its rerun sibling", () => {
  const failed = {
    ...result("second", "1"),
    status: "failure" as const,
    exitCode: 1,
    steps: [{ name: "second", seconds: 1, exitCode: 1 }],
  }
  expect(verifyResults(plan, [result("first", "1"), failed, result("second", "2")], ["success"], jobs)).toEqual([])
})

test("a newer failed or missing execution cannot fall back to an older success", () => {
  for (const conclusion of ["failure", "cancelled", null]) {
    const latest = [...jobs.slice(0, 1), { ...jobs[1]!, conclusion }]
    expect(verifyResults(plan, [result("first", "1"), result("second", "1")], ["success"], latest).join(" ")).toContain(
      "Latest execution",
    )
  }
  expect(verifyResults(plan, [result("first", "1"), result("second", "1")], ["success"], jobs).join(" ")).toContain(
    "Missing task: second",
  )
})

test("reruns still reject foreign identities, duplicate current results and unverifiable attempts", () => {
  const good = result("second", "2")
  for (const patch of [
    { sha: "old" },
    { run: "41" },
    { plan: "other" },
    { planAttempt: "2" },
    { executionAttempt: "3" },
    { unit: "first" },
  ]) {
    expect(
      verifyResults(plan, [result("first", "1"), { ...good, ...patch }], ["success"], jobs).length,
    ).toBeGreaterThan(0)
  }
  expect(verifyResults(plan, [result("first", "1"), good, good], ["success"], jobs).length).toBeGreaterThan(0)
  expect(
    verifyResults(
      plan,
      [result("first", "1"), result("second", "1"), result("second", "1"), good],
      ["success"],
      jobs,
    ).join(" "),
  ).toContain("Duplicate result")
  expect(verifyResults(plan, [result("first", "1"), good], ["success"]).length).toBeGreaterThan(0)
})

test("retained attempts keep separate report bytes and reject changed artifact identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-rerun-evidence-"))
  try {
    for (const attempt of ["1", "2"]) {
      const report = {
        path: "second/report.xml",
        kind: "junit" as const,
        sha256: new Bun.CryptoHasher("sha256").update(attempt).digest("hex"),
      }
      const directory = path.join(root, `ci-results-second-${attempt}`)
      await Bun.write(path.join(directory, report.path), attempt)
      await Bun.write(
        path.join(directory, "second/result.json"),
        JSON.stringify({ ...result("second", attempt), reports: [report] }),
      )
    }
    const history = await readResults(root)
    for (const entry of history)
      expect(new TextDecoder().decode(await verifyReport(root, entry.reports[0]!))).toBe(entry.executionAttempt)
    const latest = history.find((entry) => entry.executionAttempt === "2")!
    await Bun.write(path.join(root, latest.reports[0]!.path), "damaged")
    await expect(verifyReport(root, latest.reports[0]!)).rejects.toThrow("checksum")
    await Bun.write(path.join(root, "ci-results-first-2/second/result.json"), JSON.stringify(result("second", "2")))
    await expect(readResults(root)).rejects.toThrow("identity")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
