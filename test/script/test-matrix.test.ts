import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { createPlan } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"
import { collectTests } from "../../packages/testing/script/batches"

const tasks = await catalog()
const plan = createPlan({
  base: "a".repeat(40),
  head: "b".repeat(40),
  sha: "c".repeat(40),
  run: "test",
  mode: "full",
  changed: [],
  baseWorkspaces: [],
  headWorkspaces: [],
  tasks,
})

test("full plan retains the native harness, database and long-stream outcome matrices", () => {
  expect(
    tasks
      .filter((task) => task.kind === "benchmark-native" && task.id === `native-${task.variant}`)
      .map((task) => task.variant)
      .sort(),
  ).toEqual(["codex", "deepseek", "opencode", "pi", "synergy"])
  expect(tasks.filter((task) => task.kind === "postgres").map((task) => task.variant)).toEqual(["16", "17", "18"])
  expect(tasks.filter((task) => task.kind === "rollout").map((task) => task.variant)).toEqual([
    "completed",
    "cancelled",
    "failed",
  ])
  const assigned = [...plan.units.flatMap((unit) => unit.tasks), "benchmark-prepare"]
  expect(assigned.sort()).toEqual(plan.selected)
})

test("every task has an executable recipe and type/package checks execute once", async () => {
  const recipes = (await Promise.all(tasks.map((task) => commands(task, plan)))).flat()
  expect(recipes.filter((command) => command.name === "workspace-types")).toHaveLength(1)
  expect(recipes.filter((command) => command.name === "package:check")).toHaveLength(1)
  expect(recipes.every((command) => command.args.length > 0)).toBe(true)
  for (const task of tasks.filter((task) => task.kind === "suite")) expect(await commands(task, plan)).toHaveLength(1)
})

test("root contracts cover each file once and leave native watcher tests with prepared artifacts", async () => {
  const rootTests = tasks.find((task) => task.id === "root-tests")!
  const policy = tasks.find((task) => task.id === "policy")!
  const installed = tasks.filter((task) => task.kind === "artifacts")
  const declared = [rootTests, policy, ...installed].flatMap((task) => task.files ?? [])
  expect(declared.toSorted()).toEqual((await collectTests("test/script", process.cwd())).toSorted())
  const rootRecipe = await commands(rootTests, plan)
  expect(rootRecipe.map((command) => command.args.at(-1))).toEqual(rootTests.files!)
  expect(rootRecipe.flatMap((command) => command.args)).not.toContain("test/script/watcher-native.test.ts")
  const installedRecipes = (await Promise.all(installed.map((task) => commands(task, plan)))).flat()
  expect(installedRecipes.flatMap((command) => command.args)).toContain("test/script/watcher-native.test.ts")
})

test("normal and fault Docker groups retain the complete lifecycle file inventory", async () => {
  const groups = tasks.filter((task) => task.kind === "benchmark-docker")
  const invocations = (await Promise.all(groups.map((task) => commands(task, plan)))).flat()
  const files = [...new Set(invocations.flatMap((command) => command.args.filter((arg) => arg.endsWith(".py"))))].sort()
  expect(files).toEqual([
    "benchmark/test/test_compaction_docker.py",
    "benchmark/test/test_docker.py",
    "benchmark/test/test_native.py",
    "benchmark/test/test_oom_docker.py",
    "benchmark/test/test_oracle.py",
    "benchmark/test/test_parent_death_docker.py",
    "benchmark/test/test_recovery.py",
  ])
  for (const [index, group] of groups.entries()) {
    if (group.selection) expect(invocations[index]!.args).toContain(group.selection)
    else expect(invocations[index]!.args).not.toContain("-k")
    expect(group.scenarios!.length).toBeGreaterThan(0)
  }
})

test("native observations isolate business compaction and short model semantics with frozen preparation", async () => {
  const native = tasks.filter((task) => task.kind === "benchmark-native")
  const compaction = native.filter((task) => task.id === "native-synergy-compaction")
  const semantics = native.filter((task) => task.selection?.startsWith("test_synergy_native_semantics"))
  expect(compaction).toHaveLength(1)
  expect(semantics.flatMap((task) => task.scenarios!)).toHaveLength(4)
  for (const task of native) {
    const [recipe] = await commands(task, plan)
    expect(recipe!.env?.SYNERGY_BENCH_TEST_HARNESSES).toBe(task.variant)
    const index = recipe!.args.indexOf("-k")
    expect(index).toBeGreaterThan(-1)
    expect(recipe!.args[index + 1]).toBe(task.selection)
    if (task.variant === "synergy") {
      expect(task.needs).toContain("benchmark-prepare")
    } else expect(task.needs).not.toContain("benchmark-prepare")
  }
  expect(native.some((task) => task.selection?.includes("120_rounds"))).toBe(false)
})
