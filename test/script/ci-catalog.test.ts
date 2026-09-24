import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { changedFiles, workspaceInputs } from "../../script/ci/catalog"
import { createPlan, selectAffected, type Task } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"

const tasks: Task[] = ["synergy", "codex", "opencode", "pi", "deepseek"].map((variant) => ({
  id: `native-${variant}`,
  kind: "benchmark-native",
  variant,
  pool: "docker",
  seconds: 1,
  owners: [],
  needs: [],
}))
function plan(changed: string[]) {
  return createPlan({
    base: "a",
    head: "b",
    sha: "c",
    run: "fixture",
    mode: "affected",
    baseWorkspaces: [{ name: "benchmark", directory: "benchmark", dependencies: [], testDependencies: [] }],
    headWorkspaces: [{ name: "benchmark", directory: "benchmark", dependencies: [], testDependencies: [] }],
    changed,
    tasks,
  })
}

test("single observer selects its harness while shared protocols select all five", () => {
  expect(plan(["benchmark/runtime/capture-pi.mjs"]).selected).toEqual(["native-pi"])
  expect(plan(["benchmark/runtime/capture-plugin.mjs"]).selected).toEqual(["native-opencode"])
  expect(plan(["benchmark/runtime/capture.mjs"]).selected).toHaveLength(5)
})

test("affected type checks follow selected suites without expanding through shared check owners", async () => {
  const typecheck: Task = { id: "typecheck", kind: "typecheck", pool: "linux", seconds: 1, owners: [], needs: [] }
  const selected = {
    ...plan(["benchmark/runtime/capture-pi.mjs"]),
    tasks: [
      typecheck,
      { ...typecheck, id: "packages", kind: "packages" as const, owners: ["packages/util", "packages/harness"] },
      { ...typecheck, id: "suite-util", kind: "suite" as const, package: "packages/util", owners: ["packages/util"] },
    ],
    selected: ["typecheck", "packages", "suite-util"],
  }
  const recipe = await commands(typecheck, selected)
  expect(
    recipe.find((command) => command.name === "workspace-types")!.args.filter((arg) => arg.startsWith("--filter=")),
  ).toEqual(["--filter=@ericsanchezok/synergy-util"])
  selected.selected = ["typecheck"]
  expect((await commands(typecheck, selected)).map((command) => command.name)).toEqual(["ci-types"])
})

test("Git inventories retain removed edges and rename ownership, including test-only resource imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-graph-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI Fixture",
        GIT_AUTHOR_EMAIL: "ci@fixture.test",
        GIT_COMMITTER_NAME: "CI Fixture",
        GIT_COMMITTER_EMAIL: "ci@fixture.test",
      },
    }).trim()
  try {
    git("init", "--quiet")
    await Bun.write(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/core", "packages/client"] } }),
    )
    for (const name of ["core", "client"])
      await Bun.write(path.join(root, `packages/${name}/package.json`), JSON.stringify({ name }))
    await Bun.write(path.join(root, "packages/core/src/value.ts"), "export const value = 1")
    await Bun.write(
      path.join(root, "packages/client/test/use.test.ts"),
      'const resource = new URL("../../core/src/value.ts", import.meta.url)',
    )
    git("add", ".")
    git("commit", "--quiet", "-m", "fixture base")
    const base = git("rev-parse", "HEAD")
    await Bun.write(path.join(root, "packages/client/test/use.test.ts"), "export {}")
    git("mv", "packages/core/src/value.ts", "packages/core/src/renamed.ts")
    git("add", ".")
    git("commit", "--quiet", "-m", "fixture head")
    const head = git("rev-parse", "HEAD")
    const before = await workspaceInputs(root, base)
    const after = await workspaceInputs(root, head)
    expect(before.find((workspace) => workspace.name === "client")!.testDependencies).toEqual(["core"])
    expect(after.find((workspace) => workspace.name === "client")!.testDependencies).toEqual([])
    expect(changedFiles(root, base, head)).toContain("packages/core/src/value.ts")
    expect(changedFiles(root, base, head)).toContain("packages/core/src/renamed.ts")
    expect(selectAffected(["packages/core/src/value.ts"], before, after).packages).toContain("packages/client")
    expect(selectAffected(["packages/new/package.json"], before, after).full).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
