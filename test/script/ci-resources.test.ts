import { expect, test } from "bun:test"
import { runTaskQueue, type Task } from "../../script/ci/plan"

const task = (id: string, browser = false): Task => ({
  id,
  kind: "suite",
  pool: "linux",
  owners: [],
  needs: [],
  seconds: 1,
  prerequisites: browser ? ["browser"] : [],
})

test("heavy tasks exclude one another while light work fills free slots immediately", async () => {
  const tasks = [task("browser-a", true), task("browser-b", true), task("a"), task("b")]
  const starts = new Map(tasks.map((task) => [task.id, Promise.withResolvers<void>()]))
  const releases = new Map(tasks.map((task) => [task.id, Promise.withResolvers<void>()]))
  const running = new Set<string>()
  const seen: string[][] = []
  const finished = runTaskQueue(tasks, 2, async (task) => {
    running.add(task.id)
    seen.push([...running])
    starts.get(task.id)!.resolve()
    await releases.get(task.id)!.promise
    running.delete(task.id)
  })
  await Promise.all([starts.get("browser-a")!.promise, starts.get("a")!.promise])
  expect(running).toEqual(new Set(["browser-a", "a"]))
  releases.get("a")!.resolve()
  await starts.get("b")!.promise
  expect(running).toEqual(new Set(["browser-a", "b"]))
  releases.get("browser-a")!.resolve()
  await starts.get("browser-b")!.promise
  releases.get("browser-b")!.resolve()
  releases.get("b")!.resolve()
  await finished
  expect(seen.every((wave) => wave.length <= 2 && wave.filter((id) => id.startsWith("browser")).length <= 1)).toBe(true)
})

test("a failed task releases capacity and does not hide later results", async () => {
  const seen: string[] = []
  await expect(
    runTaskQueue([task("a", true), task("b", true)], 1, async (task) => {
      seen.push(task.id)
      if (task.id === "a") throw new Error("injected")
    }),
  ).rejects.toThrow("CI task execution failed")
  expect(seen).toEqual(["a", "b"])
})
