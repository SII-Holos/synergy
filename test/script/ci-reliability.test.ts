import { expect, test } from "bun:test"
import { createPlan, type Task, type WorkspaceInput } from "../../script/ci/plan"
import { selectAffected } from "../../script/ci/selection"
import { executeTask } from "../../script/ci/run"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workspaces: WorkspaceInput[] = [
  { directory: "apps/web", name: "web", dependencies: [], testDependencies: [] },
  { directory: "packages/consumer", name: "consumer", dependencies: [], testDependencies: ["web"] },
  { directory: "packages/server", name: "server", dependencies: ["consumer"], testDependencies: [] },
]

test("test consumers retain suites without promoting their production dependents to runtime impact", () => {
  const impact = selectAffected(["apps/web/src/view.tsx"], workspaces, workspaces)
  expect(impact.packages).toEqual(["apps/web", "packages/consumer", "packages/server"])
  expect(impact.runtimePackages).toEqual(["apps/web"])
})

test("archive metadata is policy input; arbitrary documentation executables remain unclassified", () => {
  expect(selectAffected(["docs/decisions/archived/manifest.json"], workspaces, workspaces).documentationOnly).toBe(true)
  expect(selectAffected(["docs/execute.json"], workspaces, workspaces).full).toBe(true)
})

test("registered root browser acceptance selects its owner without a full matrix", () => {
  const task = (id: string, files: string[]): Task => ({
    id,
    files,
    kind: "web",
    pool: "linux",
    owners: [],
    needs: [],
    seconds: 1,
  })
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "affected",
    changed: ["test/plugin-ui5/messages-browser.test.ts"],
    baseWorkspaces: workspaces,
    headWorkspaces: workspaces,
    tasks: [task("browser", ["test/plugin-ui5/messages-browser.test.ts"]), task("unrelated", [])],
  })
  expect(plan.selected).toEqual(["browser"])
})

test("package-relative suite paths cannot claim an unregistered root test with the same name", () => {
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "affected",
    changed: ["test/unregistered.test.ts"],
    baseWorkspaces: workspaces,
    headWorkspaces: workspaces,
    tasks: [
      {
        id: "suite",
        kind: "suite",
        pool: "linux",
        owners: ["apps/web"],
        package: "apps/web",
        files: ["test/unregistered.test.ts"],
        needs: [],
        seconds: 1,
      },
    ],
  })
  expect(plan.fullTriggers).toEqual([{ file: "test/unregistered.test.ts", reason: "shared-input" }])
})

test("preparation failure leaves a task result instead of disappearing before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-preparation-failure-"))
  try {
    const task: Task = { id: "fixture", kind: "static", pool: "linux", owners: [], needs: [], seconds: 1 }
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
    const result = await executeTask(task, plan, root, "1", async () => {
      throw new Error("producer unavailable")
    })
    expect(result.status).toBe("failure")
    expect(result.failure).toMatchObject({ phase: "prepare", message: "producer unavailable" })
    expect(result.steps).toEqual([])
    expect(await Bun.file(path.join(root, ".artifacts/ci/results/fixture/result.json")).json()).toEqual(result)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
