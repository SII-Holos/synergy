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
  const installed = tasks.find((task) => task.id === "installed-runtime")!
  const declared = [rootTests, policy, installed].flatMap((task) => task.files ?? [])
  expect(declared.toSorted()).toEqual((await collectTests("test/script", process.cwd())).toSorted())
  const rootRecipe = await commands(rootTests, plan)
  expect(rootRecipe.map((command) => command.args.at(-1))).toEqual(rootTests.files!)
  expect(rootRecipe.flatMap((command) => command.args)).not.toContain("test/script/watcher-native.test.ts")
  expect((await commands(installed, plan)).flatMap((command) => command.args)).toContain(
    "test/script/watcher-native.test.ts",
  )
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
  expect(invocations[0]!.args).toContain("not faults_preserve_terminal_evidence_and_cleanup")
  expect(invocations[1]!.args).toContain("not real_synergy_paired_rollout")
})

test("native observations isolate each JIT, protocol and model control with frozen preparation", async () => {
  const native = tasks.filter((task) => task.kind === "benchmark-native")
  const long = native.filter((task) => task.id.startsWith("native-synergy-"))
  expect(long).toHaveLength(8)
  const selections = []
  for (const task of native) {
    const [recipe] = await commands(task, plan)
    expect(recipe!.env?.SYNERGY_BENCH_TEST_HARNESSES).toBe(task.variant)
    const index = recipe!.args.indexOf("-k")
    expect(index).toBeGreaterThan(-1)
    if (long.includes(task)) {
      expect(task.variant).toBe("synergy")
      expect(task.needs).toContain("benchmark-prepare")
      selections.push(recipe!.args[index + 1])
    } else
      expect(recipe!.args[index + 1]).toBe(
        task.variant === "synergy" ? "not test_synergy_long_sessions" : "test_native_matrix",
      )
  }
  expect(selections.sort()).toEqual(
    ["jitless", "not jitless"]
      .flatMap((mode) =>
        ["chat-completions", "responses"].flatMap((protocol) =>
          ["fixture-one", "fixture-two"].map(
            (model) => `test_synergy_long_sessions and ${mode} and ${protocol} and ${model}`,
          ),
        ),
      )
      .sort(),
  )
})
