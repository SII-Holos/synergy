import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { catalog, changedFiles, workspaceInputs } from "../../script/ci/catalog"
import { buildUnits, createPlan, LIMITS, selectAffected, type Task } from "../../script/ci/plan"
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

test("independent browser suite selection retains its executable prerequisites", async () => {
  const entries = await catalog()
  for (const directory of ["apps/web", "packages/ui", "packages/browser-runtime", "packages/presets"]) {
    const suite = entries.find((entry) => entry.kind === "suite" && entry.package === directory)!
    expect(suite).toBeDefined()
    expect(buildUnits([suite], "diagnostic")[0]!.browser).toBe(true)
  }
})

test("required plans and installation-only diagnostics separate core and full controls", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "artifacts")
  expect(controls.map((entry) => entry.variant).sort()).toEqual(["core", "full"])
  const workspaces = [
    { name: "local-runtime", directory: "packages/local-runtime", dependencies: [], testDependencies: [] },
  ]
  for (const mode of ["full", "shadow", "affected", "diagnostic"] as const) {
    const selected = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode,
      changed: ["packages/local-runtime/src/process/owned-process.ts"],
      baseWorkspaces: workspaces,
      headWorkspaces: workspaces,
      tasks: entries,
      only: controls.map((entry) => entry.id),
    })
    const units = controls.map((control) => {
      const assigned = selected.units.filter((unit) => unit.tasks.includes(control.id))
      expect(assigned).toHaveLength(1)
      expect(assigned[0]!.pool).toBe("linux")
      expect(assigned[0]!.build).toBe(true)
      expect(assigned[0]!.sandbox).toBe(true)
      if (control.variant === "full") expect(assigned[0]!.tasks).toEqual([control.id])
      return assigned[0]!.id
    })
    expect(new Set(units).size).toBe(2)
    expect(selected.units.filter((unit) => unit.pool === "linux").length).toBeLessThanOrEqual(LIMITS.linux)
  }
})

test("installed controls build their own inputs and execute every distribution check once", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "artifacts")
  expect(controls).toHaveLength(2)
  const root = path.resolve(import.meta.dir, "../..")
  const selected = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "diagnostic",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: entries,
    only: controls.map((entry) => entry.id),
  })
  const core = await commands(controls.find((entry) => entry.variant === "core")!, selected)
  const full = await commands(controls.find((entry) => entry.variant === "full")!, selected)
  expect(core.map((command) => command.name)).toEqual([
    "watcher-native",
    "core-build",
    "core-installed",
    "core-pack",
    "core-install",
  ])
  expect(full.map((command) => command.name)).toEqual([
    "product-build",
    "product-installed",
    "product-composition",
    "installation-composition",
  ])
  for (const [recipe, profile, owner] of [
    [core, "core", "cli"],
    [full, "full", "presets"],
  ] as const) {
    const build = recipe.find((command) => command.name.endsWith("-build"))!
    expect(build.args.slice(1)).toEqual([`packages/${owner}/script/build.ts`, "--single", "--skip-install"])
    expect(build.env).toEqual({ SYNERGY_BUILD_TARGETS: "linux-x64", SYNERGY_REQUIRE_SANDBOX_ASSETS: "1" })
    const verify = recipe.find((command) => command.name.endsWith("-installed"))!
    expect(verify.cwd).toBe("packages/cli")
    expect(verify.args.slice(1)).toEqual(["test", "--timeout", "30000", "test/cli/artifact.test.ts"])
    expect(verify.env).toEqual({
      SYNERGY_TEST_ARTIFACT_PROFILE: profile,
      SYNERGY_TEST_ARTIFACT_BIN: path.join(root, `packages/${owner}/dist/synergy-linux-x64/bin/synergy`),
    })
  }
  expect(core[3]!.args.slice(1)).toEqual([
    "script/pack-workspace.ts",
    "packages/cli",
    path.join(root, ".artifacts/ci/core-packages"),
  ])
  expect(core[4]!.args.slice(1)).toEqual([
    "script/package-install-check.ts",
    path.join(root, ".artifacts/ci/core-packages"),
  ])
  for (const [index, file] of ["runtime-composition-check.ts", "installation-composition-check.ts"].entries()) {
    expect(full[index + 2]!.args.slice(1)).toEqual([
      `script/${file}`,
      path.join(root, "packages/presets/dist/modules-packages"),
    ])
  }
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
