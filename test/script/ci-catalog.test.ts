import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { catalog, changedFiles, workspaceInputs } from "../../script/ci/catalog"
import { distributionCommands } from "../../script/ci/distributions"
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

test("every PostgreSQL matrix executes the retained usage rebuild and clear control", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "postgres")
  expect(controls.map((entry) => entry.variant).sort()).toEqual(["16", "17", "18"])
  const selected = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: entries,
  })
  for (const control of controls) {
    expect(selected.units.flatMap((unit) => unit.tasks).filter((id) => id === control.id)).toHaveLength(1)
    const recipe = await commands(control, selected)
    const verification = recipe.find((entry) => entry.args.includes("test/storage/usage-ledger.test.ts"))
    expect(verification).toBeDefined()
    expect(verification!.cwd).toBe("packages/harness")
    expect(verification!.env?.SYNERGY_TEST_STORAGE_BACKEND).toBe("postgres")
    expect(verification!.env?.SYNERGY_REQUIRE_POSTGRES_TESTS).toBe("1")
    expect(verification!.env?.SYNERGY_TEST_POSTGRES_URL).toBeTruthy()
    expect(control.inputs).toContain("packages/harness/test/storage/usage-ledger.test.ts")
  }
})

test("every PostgreSQL matrix executes task context continuity", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "postgres")
  expect(controls.map((entry) => entry.variant).sort()).toEqual(["16", "17", "18"])
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: entries,
  })
  for (const control of controls) {
    expect(control.inputs).toContain("packages/harness/test/session/context-continuity.test.ts")
    const recipe = await commands(control, plan)
    const verification = recipe.find((entry) => entry.args.includes("test/session/context-continuity.test.ts"))
    expect(verification).toBeDefined()
    expect(verification!.cwd).toBe("packages/harness")
    expect(verification!.env?.SYNERGY_TEST_STORAGE_BACKEND).toBe("postgres")
    expect(verification!.env?.SYNERGY_REQUIRE_POSTGRES_TESTS).toBe("1")
    expect(verification!.env?.SYNERGY_TEST_POSTGRES_URL).toBeTruthy()
  }
})

test("Environment acceptance retains executable coverage and required Docker evidence", async () => {
  const entries = await catalog()
  const environment = entries.find((entry) => entry.kind === "environment")!
  const workspaces = ["harness", "local-runtime", "media", "presets"].map((name) => ({
    name,
    directory: `packages/${name}`,
    dependencies: name === "harness" ? [] : ["harness"],
    testDependencies: [],
  }))
  for (const file of [
    "packages/harness/src/environment/execution.ts",
    "packages/local-runtime/test/environment/docker.test.ts",
    "packages/harness/src/session/input-attachment.ts",
  ]) {
    const selected = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "affected",
      changed: [file],
      baseWorkspaces: workspaces,
      headWorkspaces: workspaces,
      tasks: entries,
    })
    expect(selected.selected).toContain(environment.id)
    expect(selected.units.flatMap((unit) => unit.tasks).filter((id) => id === environment.id)).toHaveLength(1)
    expect(selected.selected).toContain("installed-full-composition")
  }
  expect(environment.scenarios).toContain(
    "remote Docker Engine and execution endpoints share the lifecycle over authenticated TLS",
  )
  expect(environment.scenarios).toContain(
    "Docker Workspace checkpoints survive upload failure and replacement of the entire allocation",
  )
})
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

test("required plans and installation diagnostics retain every control within the Linux worker budget", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "artifacts")
  expect(controls).toHaveLength(9)
  expect(LIMITS.linux).toBe(12)
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
    for (const control of controls) {
      const assigned = selected.units.filter((unit) => unit.tasks.includes(control.id))
      expect(assigned).toHaveLength(1)
      expect(assigned[0]!.pool).toBe("linux")
      expect(assigned[0]!.build).toBe(true)
      expect(assigned[0]!.sandbox).toBe(true)
      expect(assigned[0]![control.profile!]).toBe(true)
    }
    const linux = selected.units.filter((unit) => unit.pool === "linux")
    expect(linux.length).toBeLessThanOrEqual(LIMITS.linux)
    expect(linux.filter((unit) => unit.build).length).toBeLessThanOrEqual(LIMITS.linux - 1)
  }
  for (const control of controls) {
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
      only: [control.id],
    })
    expect(selected.selected).toEqual([control.id])
    expect(selected.units.flatMap((unit) => unit.tasks)).toEqual([control.id])
    const unit = selected.units.find((unit) => unit.tasks.includes(control.id))!
    expect(unit.core).toBe(control.profile === "core")
    expect(unit.full).toBe(control.profile === "full")
  }
})

test("installed controls share two profile builds while preserving every distribution behavior exactly once", async () => {
  const entries = await catalog()
  const controls = entries.filter((entry) => entry.kind === "artifacts")
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
  const scenarioName = (id: string) => `installed runtime artifact preserves ${id} outcome outside the repository`
  const expected = ["complete", "tool", "read", "budget", "timeout", "permission"].map(scenarioName).sort()
  const recipes = await Promise.all(controls.map(async (task) => ({ task, commands: await commands(task, selected) })))
  const producerScripts: string[] = []
  for (const [profile, owner] of [
    ["core", "cli"],
    ["full", "presets"],
  ] as const) {
    const producer = distributionCommands(profile, root)
    const builds = producer.filter((command) => command.args.includes(`packages/${owner}/script/build.ts`))
    expect(builds).toHaveLength(1)
    expect(builds[0]!.args).toContain("--single")
    expect(builds[0]!.args).toContain("--skip-install")
    producerScripts.push(...producer.map((command) => command.args[1]!))
    const binaries = controls.filter((entry) => entry.variant === "binary" && entry.profile === profile)
    expect(binaries.flatMap((entry) => entry.scenarios ?? []).sort()).toEqual(
      profile === "full" ? expected : [scenarioName("tool")],
    )
  }
  for (const { task, commands: recipe } of recipes) {
    expect(recipe.some((command) => command.args.some((arg) => producerScripts.includes(arg)))).toBe(false)
    if (task.variant !== "binary" && task.variant !== "package") continue
    const verification = recipe.filter((command) => command.env?.SYNERGY_TEST_ARTIFACT_SCENARIOS !== undefined)
    expect(verification).toHaveLength(1)
    const verify = verification[0]!
    expect(verify.env?.SYNERGY_TEST_ARTIFACT_PROFILE).toBe(task.profile)
    const scenarios: string[] = JSON.parse(verify.env!.SYNERGY_TEST_ARTIFACT_SCENARIOS!)
    expect(scenarios.map(scenarioName).sort()).toEqual(task.scenarios!.toSorted())
    if (task.variant === "package") continue
    expect(verify.cwd).toBe("packages/cli")
    expect(verify.args).toContain("test/cli/artifact.test.ts")
    const owner = task.profile === "core" ? "cli" : "presets"
    expect(verify.env?.SYNERGY_TEST_ARTIFACT_BIN).toBe(
      path.join(root, `packages/${owner}/dist/synergy-linux-x64/bin/synergy`),
    )
  }
  const packages = controls.filter((entry) => entry.variant === "package")
  expect(packages).toHaveLength(1)
  expect(packages[0]!.profile).toBe("core")
  expect(packages[0]!.scenarios!.toSorted()).toEqual([scenarioName("complete")])
  const consumers = recipes.flatMap((recipe) => recipe.commands)
  expect(consumers.filter((command) => command.args.includes("test/script/watcher-native.test.ts"))).toHaveLength(1)
  const pack = distributionCommands("core", root).filter((command) => command.args.includes("script/pack-workspace.ts"))
  expect(pack).toHaveLength(1)
  const install = consumers.filter((command) => command.args.includes("script/package-install-check.ts"))
  expect(install).toHaveLength(1)
  expect(install[0]!.args.at(-1)).toBe(pack[0]!.args.at(-1))
  expect(install[0]!.env?.SYNERGY_TEST_ARTIFACT_JUNIT).toEndWith(".xml")
  const product = consumers.filter((command) => command.args.includes("script/runtime-composition-check.ts"))
  expect(product).toHaveLength(1)
  expect(product[0]!.args.at(-1)).toBe(path.join(root, "packages/presets/dist/modules-packages"))
  const installation = consumers.filter((command) => command.args.includes("script/installation-composition-check.ts"))
  expect(installation.map((command) => command.args.at(-1)).sort()).toEqual(["company", "components", "web"])
  for (const command of installation)
    expect(command.args.at(-2)).toBe(path.join(root, "packages/presets/dist/modules-packages"))
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
