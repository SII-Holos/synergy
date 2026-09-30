import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { loadManifest } from "../../script/coverage-check"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

test("every coverage owner has its complete disjoint suite partitions", async () => {
  const suites = (await catalog(root)).filter((task) => task.kind === "suite")
  const manifest = await loadManifest(root)
  expect([...new Set(suites.map((task) => task.package))].sort()).toEqual(Object.keys(manifest.packages).sort())
  for (const owner of Object.keys(manifest.packages)) {
    const tasks = suites.filter((task) => task.package === owner)
    const counts: Record<string, number> = {
      "packages/harness": 4,
      "apps/web": 4,
      "packages/presets": 4,
      "packages/ui": 2,
      "packages/local-runtime": 2,
    }
    expect(tasks).toHaveLength(counts[owner] ?? 1)
    if (tasks.length > 1)
      expect(tasks.map((task) => task.partition)).toEqual(Array.from({ length: tasks.length }, (_, index) => index))
    const assigned = tasks.flatMap((task) => task.files!)
    expect(assigned.length).toBe(new Set(assigned).size)
  }
})
