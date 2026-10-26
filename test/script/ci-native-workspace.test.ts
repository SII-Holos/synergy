import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { createPlan, executionQueue } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"
import { verifyResults } from "../../script/ci/evidence"
import { verifyScenarios } from "../../script/ci/junit"
import { fileHash } from "../../script/ci/artifacts"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { nativeWorkspaceBatches } from "../../script/native-workspace-coverage"

test("affected native plans retain the complete Local Runtime coverage contributors", async () => {
  const tasks = await catalog()
  const workspaces = [
    { name: "web", directory: "apps/web", dependencies: [], testDependencies: [] },
    { name: "desktop", directory: "apps/desktop", dependencies: [], testDependencies: ["web"] },
    { name: "runtime", directory: "packages/local-runtime", dependencies: [], testDependencies: [] },
  ]
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "affected",
    changed: ["packages/local-runtime/src/process/native-pty.ts"],
    baseWorkspaces: workspaces,
    headWorkspaces: workspaces,
    tasks,
  })
  expect(plan.selected).toContain("windows-native")
  for (const owner of ["packages/local-runtime", "packages/cli", "packages/presets"]) {
    const suites = tasks.filter((task) => task.kind === "suite" && task.package === owner)
    expect(suites.length).toBeGreaterThan(0)
    for (const suite of suites) expect(plan.selected).toContain(suite.id)
    const executed = plan.units.flatMap((unit) => unit.tasks).filter((id) => suites.some((suite) => suite.id === id))
    expect(executed.toSorted()).toEqual(suites.map((suite) => suite.id).toSorted())
  }
  expect(plan.selected).not.toContain("suite-packages-server")
})

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
  const windows = tasks.find((task) => task.id === "windows-native")!
  expect(windows.owners).toContain("packages/cli")
  for (const task of [macos!, windows]) {
    expect(task.package).toBe("packages/local-runtime")
    expect(task.outputs).toContain("lcov")
    expect(task.outputs).toContain("junit")
    expect(task.needs).toEqual(["suite-packages-local-runtime-0", "suite-packages-local-runtime-1"])
    const recipe = await commands(task, plan)
    const missing: string[] = []
    for (const command of recipe) {
      for (const file of command.args.filter((arg) => arg.endsWith(".ts"))) {
        const target = path.resolve(command.cwd ?? ".", file)
        if (!(await Bun.file(target).exists())) missing.push(target)
      }
    }
    expect(missing).toEqual([])
    expect(recipe.some((command) => command.args.includes("packages/local-runtime/script/build-pty.ts"))).toBe(true)
    expect(recipe.some((command) => command.args.includes("script/native-workspace-coverage.ts"))).toBe(true)
    const result = {
      version: 2 as const,
      task: task.id,
      unit: plan.units.find((unit) => unit.tasks.includes(task.id))!.id,
      plan: plan.digest,
      sha: plan.sha,
      run: plan.run,
      planAttempt: plan.attempt,
      executionAttempt: plan.attempt,
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

test("native batches retain every Windows and macOS control without overlapping files", async () => {
  for (const windows of [true, false]) {
    const batches = nativeWorkspaceBatches(windows)
    expect(batches.length).toBe(windows ? 2 : 1)
    const files = batches.flat()
    expect(new Set(files).size).toBe(files.length)
    for (const file of files) {
      expect(await stat(path.resolve("packages/local-runtime", file))).toBeDefined()
    }
    expect(files).toContain("test/workspace/change-attribution.test.ts")
    expect(files).toContain("test/workspace/workspace-concurrency.test.ts")
    expect(files).toContain("../harness/test/session/snapshot-long-path.test.ts")
    expect(files).toContain("../lsp/test/lsp/process.test.ts")
    expect(files.includes("test/file/watcher-native-queue.test.ts")).toBe(!windows)
    expect(files).toContain(
      windows ? "test/process/owned-process-windows.test.ts" : "test/workspace/darwin-coalition.test.ts",
    )
  }
})

test("real macOS signing is selected independently of Linux skips without rebuilding the full runtime", async () => {
  const tasks = await catalog()
  const signing = tasks.find((task) => task.id === "macos-signing")!
  expect(signing).toBeDefined()
  const files = ["test/mac-signing.test.ts", "test/runtime-seal.test.ts", "test/packaging.test.ts"]
  expect(signing.files).toEqual(files.map((file) => `apps/desktop/${file}`))
  expect(signing.scenarios).toEqual([
    "native macOS signing seals the final module bytes before the app signature",
    "signs config-only development apps without inventing a runtime",
    "propagates real codesign errors from fail-child to the packager",
    "propagates real codesign errors from fail-app to the packager",
  ])
  expect(signing.outputs).toEqual(["junit"])
  const desktopSuite = tasks.find((task) => task.kind === "suite" && task.package === "apps/desktop")!
  for (const file of files) expect(desktopSuite.files).not.toContain(file)
  const workspaces = [
    { name: "desktop", directory: "apps/desktop", dependencies: [], testDependencies: [] },
    { name: "plugin-host", directory: "packages/plugin-host", dependencies: [], testDependencies: [] },
  ]
  for (const changed of [
    "apps/desktop/script/mac-sign.cjs",
    "apps/desktop/script/after-pack.cjs",
    "apps/desktop/electron-builder.json",
    ...signing.files!,
    "packages/plugin-host/src/installation/generations.ts",
    "bun.lock",
  ]) {
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "affected",
      changed: [changed],
      baseWorkspaces: workspaces,
      headWorkspaces: workspaces,
      tasks,
    })
    expect(plan.selected).toContain(signing.id)
    const units = plan.units.filter((unit) => unit.tasks.includes(signing.id))
    expect(units).toHaveLength(1)
    expect(executionQueue(units[0]!)).toBe("macos")
    expect(units[0]).toMatchObject({ core: false, full: false, desktop: false, sandbox: false })
    expect(signing.needs).toEqual([])
    expect(await commands(signing, plan)).toEqual([
      {
        name: "macos-signing",
        args: [process.execPath, "test", "--timeout", "30000", ...files],
        cwd: "apps/desktop",
      },
    ])
  }
})

test("missing or skipped real macOS signing evidence cannot satisfy All checks passed", async () => {
  const task = (await catalog()).find((entry) => entry.id === "macos-signing")!
  expect(task).toBeDefined()
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [task],
  })
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-signing-evidence-"))
  try {
    for (const outcome of ["passed", "skipped", "absent"]) {
      const cases = task.scenarios!.map(
        (name) => `<testcase name="${name}">${outcome === "skipped" ? "<skipped/>" : ""}</testcase>`,
      )
      await Bun.write(
        path.join(root, "signing.xml"),
        `<testsuite>${outcome === "absent" ? "" : cases.join("")}</testsuite>`,
      )
      const errors = await verifyScenarios(root, plan, [
        {
          version: 2,
          task: task.id,
          unit: plan.units[0]!.id,
          plan: plan.digest,
          sha: plan.sha,
          run: plan.run,
          planAttempt: plan.attempt,
          executionAttempt: plan.attempt,
          mode: plan.mode,
          status: "success",
          exitCode: 0,
          started: new Date().toISOString(),
          completed: new Date().toISOString(),
          steps: [{ name: task.id, seconds: 1, exitCode: 0 }],
          reports: [{ kind: "junit", path: "signing.xml", sha256: await fileHash(path.join(root, "signing.xml")) }],
        },
      ])
      expect(errors).toHaveLength(outcome === "passed" ? 0 : task.scenarios!.length)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
