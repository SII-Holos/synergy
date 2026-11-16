import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlan, type Task } from "../../script/ci/plan"
import { executeTask } from "../../script/ci/run"
import { verifyResults } from "../../script/ci/evidence"
import { verifyCoverage } from "../../script/ci/coverage"
import { verifyScenarios } from "../../script/ci/junit"

// Real children prove that split package evidence must remain complete before threshold admission.
test("a complete partitioned suite passes; missing partitions, omitted files and stale reports cannot contribute coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-run-"))
  const inheritedAttempt = process.env.GITHUB_RUN_ATTEMPT
  try {
    process.env.GITHUB_RUN_ATTEMPT = "2"
    const owner = "packages/example"
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: [owner] } }))
    await Bun.write(path.join(root, owner, "package.json"), '{"name":"example"}')
    for (const [name, expected] of [
      ["value", 42],
      ["other", 7],
    ] as const) {
      await Bun.write(path.join(root, owner, `src/${name}.ts`), `export function ${name}() { return ${expected} }`)
      await Bun.write(
        path.join(root, owner, `test/${name}.test.ts`),
        `import {test,expect} from "bun:test"; import {${name}} from "../src/${name}"; test("${name}",()=>expect(${name}()).toBe(${expected}));`,
      )
    }
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
      tasks: ["value", "other"].map((name, partition): Task => ({
        id: `suite-${partition}`,
        kind: "suite",
        pool: "linux",
        owners: [owner],
        needs: [],
        seconds: 1,
        package: owner,
        partition,
        files: [`test/${name}.test.ts`],
        scenarios: [name],
      })),
    })
    const results = []
    for (const task of plan.tasks) results.push(await executeTask(task, plan, root))
    expect(results.every((result) => result.executionAttempt === plan.attempt)).toBe(true)
    expect(verifyResults(plan, results, ["success"])).toEqual([])
    const reports = path.join(root, ".artifacts/ci/results")
    expect(await verifyScenarios(reports, plan, results)).toEqual([])
    expect((await verifyCoverage(root, reports, plan, results)).errors).toEqual([])
    const missing = await verifyCoverage(root, reports, plan, results.slice(0, 1), { diagnostic: true })
    expect(missing.incomplete).toContain(owner)
    expect(verifyResults(plan, results.slice(0, 1), ["success"])).toContain("Missing task: suite-1")
    await Bun.write(path.join(root, owner, "src/unmeasured.ts"), "export const missing = 1")
    const unrelated: Task = {
      id: "unrelated",
      kind: "suite",
      pool: "linux",
      owners: ["packages/unrelated"],
      package: "packages/unrelated",
      needs: [],
      seconds: 1,
      files: ["test/example.test.ts"],
    }
    const diagnostics = await verifyCoverage(
      root,
      reports,
      { ...plan, tasks: [...plan.tasks, unrelated], selected: [...plan.selected, unrelated.id] },
      results,
      { diagnostic: true },
    )
    expect(diagnostics.verdicts.find((entry) => entry.package === owner)?.missing).toBe(1)
    expect(diagnostics.incomplete).toContain("packages/unrelated")
    await rm(path.join(root, owner, "src/unmeasured.ts"))
    const result = results[0]!
    const timing = result.reports.find((report) => report.kind === "timing")!
    const omitted = { ...result, reports: result.reports.filter((report) => report !== timing) }
    expect((await verifyCoverage(root, reports, plan, [omitted, results[1]!])).errors).toContain(
      "Incomplete or repeated test inventory: suite-0",
    )
    const lcov = result.reports.find((report) => report.kind === "lcov")!
    await Bun.write(path.join(reports, lcov.path), "old report")
    await expect(verifyCoverage(root, reports, plan, results)).rejects.toThrow("checksum")
  } finally {
    if (inheritedAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT
    else process.env.GITHUB_RUN_ATTEMPT = inheritedAttempt
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
