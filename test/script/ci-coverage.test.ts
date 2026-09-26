import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlan, type Task } from "../../script/ci/plan"
import { executeTask } from "../../script/ci/run"
import { verifyResults } from "../../script/ci/evidence"
import { verifyCoverage } from "../../script/ci/coverage"

// A real child proves that execution, inventory evidence and threshold admission agree.
test("a fresh complete suite passes; omitted files and stale reports cannot contribute coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-run-"))
  try {
    const owner = "packages/example"
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: [owner] } }))
    await Bun.write(path.join(root, owner, "package.json"), '{"name":"example"}')
    await Bun.write(path.join(root, owner, "src/value.ts"), "export function value() { return 42 }")
    await Bun.write(
      path.join(root, owner, "test/value.test.ts"),
      'import {test,expect} from "bun:test"; import {value} from "../src/value"; test("value",()=>expect(value()).toBe(42));',
    )
    const runner = path.resolve(import.meta.dir, "../../packages/testing/script/run.ts")
    await Bun.write(
      path.join(root, "script/coverage-exempt.json"),
      JSON.stringify({
        packages: {
          [owner]: {
            command: `bun ${runner} --coverage`,
            lcov: "coverage/lcov.info",
            thresholds: { lines: 100, functions: 100 },
            exempt: [],
          },
        },
      }),
    )
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks: [
        {
          id: "suite",
          kind: "suite",
          pool: "linux",
          owners: [owner],
          needs: [],
          seconds: 1,
          package: owner,
          files: ["test/value.test.ts"],
        },
      ],
    })
    const result = await executeTask(plan.tasks[0]!, plan, root)
    expect(verifyResults(plan, [result], ["success"])).toEqual([])
    const reports = path.join(root, ".artifacts/ci/results")
    expect((await verifyCoverage(root, reports, plan, [result])).errors).toEqual([])
    const timing = result.reports.find((report) => report.kind === "timing")!
    const omitted = { ...result, reports: result.reports.filter((report) => report !== timing) }
    expect((await verifyCoverage(root, reports, plan, [omitted])).errors).toContain(
      "Incomplete or repeated test inventory: suite",
    )
    const lcov = result.reports.find((report) => report.kind === "lcov")!
    await Bun.write(path.join(reports, lcov.path), "old report")
    await expect(verifyCoverage(root, reports, plan, [result])).rejects.toThrow("checksum")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an injected downstream regression is selected and makes real execution fail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-downstream-"))
  try {
    const owners = ["packages/core", "packages/consumer", "packages/unrelated"]
    const runner = path.resolve(import.meta.dir, "../../packages/testing/script/run.ts")
    await Bun.write(
      path.join(root, "script/coverage-exempt.json"),
      JSON.stringify({
        packages: Object.fromEntries(
          owners.map((owner) => [
            owner,
            {
              command: `bun ${runner} --coverage`,
              lcov: "coverage/lcov.info",
              thresholds: { lines: 0, functions: 0 },
              exempt: [],
            },
          ]),
        ),
      }),
    )
    await Bun.write(path.join(root, "packages/core/src/value.ts"), "export function value() { return 43 }")
    await Bun.write(
      path.join(root, "packages/core/test/value.test.ts"),
      'import {test,expect} from "bun:test"; import {value} from "../src/value"; test("number",()=>expect(typeof value()).toBe("number"));',
    )
    await Bun.write(
      path.join(root, "packages/consumer/test/value.test.ts"),
      'import {test,expect} from "bun:test"; import {value} from "../../core/src/value"; test("consumer contract",()=>expect(value()).toBe(42));',
    )
    const tasks: Task[] = owners.map((owner) => ({
      id: owner,
      kind: "suite",
      pool: "linux",
      owners: [owner],
      package: owner,
      needs: [],
      seconds: 1,
      files: ["test/value.test.ts"],
    }))
    const graph = owners.map((directory) => ({
      directory,
      name: directory,
      dependencies: [],
      testDependencies: directory === "packages/consumer" ? ["packages/core"] : [],
    }))
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "merge",
      run: "fixture",
      mode: "affected",
      changed: ["packages/core/src/value.ts"],
      baseWorkspaces: graph,
      headWorkspaces: graph,
      tasks,
    })
    expect(plan.selected).toEqual(["packages/consumer", "packages/core"])
    const results = await Promise.all(
      tasks.filter((task) => plan.selected.includes(task.id)).map((task) => executeTask(task, plan, root)),
    )
    expect(results.find((result) => result.task === "packages/core")!.status).toBe("success")
    expect(results.find((result) => result.task === "packages/consumer")!.status).toBe("failure")
    expect(verifyResults(plan, results, ["success"]).join(" ")).toContain("Failed task: packages/consumer")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
