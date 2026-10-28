import { expect, test } from "bun:test"
import { executionWaves, type Task } from "../../script/ci/plan"

const task = (id: string, browser = false): Task => ({
  id,
  kind: "suite",
  pool: "linux",
  owners: [],
  needs: [],
  seconds: 1,
  prerequisites: browser ? ["browser"] : [],
})

test("browser tasks own the runner while light tasks share its two slots", () => {
  const tasks = [task("a"), task("b"), task("browser", true), task("c"), task("d")]
  expect(executionWaves(tasks, 2).map((wave) => wave.map((task) => task.id))).toEqual([
    ["a", "b"],
    ["browser"],
    ["c", "d"],
  ])
  expect(executionWaves(tasks, 1).every((wave) => wave.length === 1)).toBe(true)
})

test("native builds do not compete with a neighboring test process", () => {
  const build = { ...task("build"), kind: "typecheck" as const }
  expect(executionWaves([task("a"), build, task("b")], 2).map((wave) => wave.length)).toEqual([1, 1, 1])
})
