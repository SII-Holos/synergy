import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { catalog } from "../../script/ci/catalog"
import { distributionPaths } from "../../script/ci/distributions"
import { type TaskResult } from "../../script/ci/evidence"
import { verifyScenarios } from "../../script/ci/junit"
import { createPlan, executionQueue } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"

const id = "installed-full-released-upgrade"
const file = "test/script/release/released-upgrade.test.ts"
const scenario = "released 3.0.22 preserves history, plugins and assets through upgrade, restart and backup recovery"

test("released upgrade belongs to the shared full pool and not root-tests", async () => {
  const entries = await catalog()
  const upgrade = entries.find((entry) => entry.id === id)!
  expect(upgrade).toBeDefined()
  expect(upgrade).toMatchObject({
    kind: "artifacts",
    profile: "full",
    variant: "released-upgrade",
    pool: "linux",
    files: [file],
    scenarios: [scenario],
    outputs: ["junit"],
  })
  expect(entries.find((entry) => entry.id === "root-tests")!.files).not.toContain(file)
  expect(entries.find((entry) => entry.id === "root-tests")!.files).toContain(
    "test/script/release/verify-released-upgrade.test.ts",
  )
  const workspaces = ["cli", "presets", "harness", "local-runtime"].map((name) => ({
    name,
    directory: `packages/${name}`,
    dependencies: [],
    testDependencies: [],
  }))
  for (const mode of ["full", "shadow", "affected", "diagnostic"] as const) {
    for (const changed of [file, "packages/presets/src/full.ts", "packages/harness/src/storage/migration.ts"]) {
      const plan = createPlan({
        base: "base",
        head: "head",
        sha: "tested",
        run: "fixture",
        mode,
        changed: [changed],
        baseWorkspaces: workspaces,
        headWorkspaces: workspaces,
        tasks: entries,
        only: [id],
      })
      expect(plan.selected).toContain(id)
      const units = plan.units.filter((unit) => unit.tasks.includes(id))
      expect(units).toHaveLength(1)
      expect(executionQueue(units[0]!)).toBe("linux_full")
      expect(units[0]).toMatchObject({ full: true, sandbox: true, build: true })
    }
  }
})

test("released upgrade recipe uses the existing full candidate's exact dev version without another build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-upgrade-recipe-"))
  try {
    const entries = await catalog()
    const task = entries.find((entry) => entry.id === id)!
    expect(task).toBeDefined()
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "diagnostic",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks: entries,
      only: [id],
    })
    const candidate = path.join(root, distributionPaths("full")[0]!)
    await mkdir(candidate, { recursive: true })
    await Bun.write(path.join(candidate, "package.json"), JSON.stringify({ version: "0.0.0-dev-20261025" }))
    const recipe = await commands(task, plan, root)
    expect(recipe).toHaveLength(1)
    expect(recipe[0]!.args).toEqual([
      process.execPath,
      "script/release/verify-released-upgrade.ts",
      "--candidate",
      candidate,
      "--version",
      "0.0.0-dev-20261025",
      "--junit",
      path.join(root, ".artifacts/ci/raw", id, "upgrade.xml"),
    ])
    await rm(path.join(candidate, "package.json"))
    await expect(commands(task, plan, root)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["passed", "skipped", "absent", "duplicate"])(
  "All checks passed requires exactly one real released-upgrade scenario: %s",
  async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ci-upgrade-admission-"))
    try {
      const task = (await catalog()).find((entry) => entry.id === id)!
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
      const testcase = `<testcase name="${scenario}">${outcome === "skipped" ? "<skipped/>" : ""}</testcase>`
      const xml = `<testsuite>${outcome === "absent" ? "" : testcase.repeat(outcome === "duplicate" ? 2 : 1)}</testsuite>`
      await Bun.write(path.join(root, "upgrade.xml"), xml)
      const result: TaskResult = {
        version: 2,
        task: id,
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
        reports: [{ path: "upgrade.xml", kind: "junit", sha256: createHash("sha256").update(xml).digest("hex") }],
        steps: [{ name: "released-upgrade", seconds: 1, exitCode: 0 }],
      }
      expect(await verifyScenarios(root, plan, [result])).toHaveLength(outcome === "passed" ? 0 : 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
