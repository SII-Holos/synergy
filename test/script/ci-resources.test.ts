import { expect, test } from "bun:test"
import { buildUnits, runTaskQueue, unitTimeoutMinutes, type Task } from "../../script/ci/plan"
import { catalog } from "../../script/ci/catalog"

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

test("native Runtime and Harness suites exclude other heavy work while light work uses the second slot", async () => {
  const entries = await catalog()
  const suites = entries.filter(
    (entry) =>
      entry.kind === "suite" && ["packages/organization-runtime", "packages/harness"].includes(entry.package ?? ""),
  )
  const heavy = [
    ...suites,
    entries.find((entry) => entry.kind === "typecheck")!,
    entries.find((entry) => entry.kind === "suite" && entry.package === "apps/web")!,
  ]
  const light = [task("light-a"), task("light-b")]
  const tasks = [...heavy, ...light]
  const starts = new Map(tasks.map((entry) => [entry.id, Promise.withResolvers<void>()]))
  const releases = new Map(tasks.map((entry) => [entry.id, Promise.withResolvers<void>()]))
  const running = new Set<string>()
  const seen: string[][] = []
  const finished = runTaskQueue(tasks, 2, async (entry) => {
    running.add(entry.id)
    seen.push([...running])
    starts.get(entry.id)!.resolve()
    await releases.get(entry.id)!.promise
    running.delete(entry.id)
  })
  try {
    await starts.get(heavy[0]!.id)!.promise
    expect(running).toEqual(new Set([heavy[0]!.id, "light-a"]))
    releases.get("light-a")!.resolve()
    await starts.get("light-b")!.promise
    for (const [index, entry] of heavy.entries()) {
      await starts.get(entry.id)!.promise
      expect(running).toEqual(new Set([entry.id, "light-b"]))
      releases.get(entry.id)!.resolve()
      if (index + 1 < heavy.length) await starts.get(heavy[index + 1]!.id)!.promise
    }
    releases.get("light-b")!.resolve()
  } finally {
    for (const release of releases.values()) release.resolve()
    await finished
  }
  const ids = new Set(heavy.map((entry) => entry.id))
  expect(seen.every((wave) => wave.length <= 2 && wave.filter((id) => ids.has(id)).length <= 1)).toBe(true)
  const modeledSuites = ["packages/harness", "packages/organization-runtime"].map((owner) =>
    suites.find((entry) => entry.package === owner)!,
  )
  const modeled = buildUnits(
    [
      ...modeledSuites.map((entry) => ({ ...entry, seconds: 5, profile: "core" as const })),
      { ...task("modeled-light"), seconds: 3, profile: "core" as const },
    ],
    "full",
  )
  expect(modeled).toHaveLength(1)
  expect(modeled[0]!.seconds).toBe(10)
  const capacity = suites.find((entry) => entry.files?.includes("test/capacity-sync.test.ts"))!
  const adjacent = suites.find((entry) => entry.package === capacity.package && entry.id !== capacity.id)!
  const capacityTasks = [capacity, adjacent]
  const capacityUnits = buildUnits(capacityTasks, "full")
  const original = capacityUnits.find((unit) => unit.tasks.includes(capacity.id))!
  const sibling = capacityUnits.find((unit) => unit.tasks.includes(adjacent.id))!
  expect(original.id).not.toBe(sibling.id)
  expect(unitTimeoutMinutes(original, capacityTasks)).toBe(55)
  expect(unitTimeoutMinutes(sibling, capacityTasks)).toBe(45)
  const moved = [
    { ...capacity, files: capacity.files!.filter((file) => file !== "test/capacity-sync.test.ts") },
    { ...adjacent, files: [...adjacent.files!, "test/capacity-sync.test.ts"] },
  ]
  expect(unitTimeoutMinutes(original, moved)).toBe(45)
  expect(unitTimeoutMinutes(sibling, moved)).toBe(55)
  expect(unitTimeoutMinutes({ ...sibling, id: "renamed-capacity-owner" }, moved)).toBe(55)
  expect(unitTimeoutMinutes(original, [{ ...capacity, package: "packages/local-runtime" }])).toBe(45)
})
