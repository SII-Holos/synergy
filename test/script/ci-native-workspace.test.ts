import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { createPlan, executionQueue } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"
import { verifyResults } from "../../script/ci/evidence"

test("native Workspace verification stays in the plan with fresh platform coverage", async () => {
  const tasks = await catalog()
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks,
  })
  const macos = tasks.find((task) => task.id === "macos-workspace")
  expect(macos).toBeDefined()
  const windows = tasks.find((task) => task.id === "windows")!
  expect(windows.owners).toContain("packages/cli")
  for (const task of [macos!, windows]) {
    expect(task.package).toBe("packages/runtime-local")
    expect(task.outputs).toContain("lcov")
    expect(task.outputs).toContain("junit")
    expect(task.needs).toContain("suite-packages-runtime-local")
    const recipe = await commands(task, plan)
    expect(recipe.some((command) => command.args.includes("packages/runtime-local/script/build-pty.ts"))).toBe(true)
    expect(recipe.some((command) => command.args.includes("script/native-workspace-coverage.ts"))).toBe(true)
    const result = {
      version: 1 as const,
      task: task.id,
      plan: plan.digest,
      sha: plan.sha,
      run: plan.run,
      attempt: plan.attempt,
      mode: plan.mode,
      status: "success" as const,
      exitCode: 0,
      started: new Date().toISOString(),
      completed: new Date().toISOString(),
      reports: [],
      steps: [{ name: "native", seconds: 1, exitCode: 0 }],
    }
    expect(verifyResults(plan, [result], ["success"])).toContain(`Missing lcov evidence: ${task.id}`)
  }
  expect((await commands(windows, plan)).some((command) => command.args.includes("test/cli/data-files.test.ts"))).toBe(
    true,
  )
  const unit = plan.units.find((entry) => entry.tasks.includes(macos!.id))!
  expect(executionQueue(unit, tasks)).toBe("macos")
})

test("the required aggregate waits for native macOS results from the tested revision", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()) as {
    jobs: Record<
      string,
      { needs?: string[]; "runs-on"?: string; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }
    >
  }
  const native = workflow.jobs.macos
  expect(native).toBeDefined()
  expect(native!["runs-on"]).toBe("macos-15")
  expect(workflow.jobs["all-checks-passed"]!.needs).toContain("macos")
  expect(native!.steps!.find((step) => step.uses?.startsWith("actions/checkout"))!.with!.ref).toBe(
    "${{ needs.plan.outputs.sha }}",
  )
  expect(native!.steps!.find((step) => step.uses?.startsWith("actions/upload-artifact"))!.with!.path).toBe(
    ".artifacts/ci/results",
  )
})
