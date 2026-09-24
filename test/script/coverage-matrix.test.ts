import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { loadManifest } from "../../script/coverage-check"
import { executionBatches } from "../../packages/testing/script/run"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

test("one discovered suite per coverage owner, with disjoint stable Harness partitions", async () => {
  const suites = (await catalog(root)).filter((task) => task.kind === "suite")
  const manifest = await loadManifest(root)
  expect([...new Set(suites.map((task) => task.package))].sort()).toEqual(Object.keys(manifest.packages).sort())
  for (const owner of Object.keys(manifest.packages)) {
    const tasks = suites.filter((task) => task.package === owner)
    if (owner !== "packages/harness") {
      expect(tasks).toHaveLength(1)
      continue
    }
    expect(tasks.map((task) => task.partition)).toEqual([0, 1, 2, 3])
    const batches = executionBatches(tasks[0]!.files!, path.join(root, owner), 4)
    const assigned = tasks.flatMap((task) =>
      batches.filter((batch) => batch.partition === task.partition).flatMap((batch) => batch.files),
    )
    expect(assigned.length).toBe(new Set(assigned).size)
    expect(assigned.sort()).toEqual(tasks[0]!.files)
  }
})
