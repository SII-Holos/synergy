import { expect, test } from "bun:test"
import path from "node:path"
import { catalog } from "../../script/ci/catalog"
import { collectTests } from "../../packages/testing/script/batches"
import { suiteBatches } from "../../script/ci/suites"

test("slow package partitions execute every file once without splitting an isolation batch", async () => {
  const tasks = await catalog()
  for (const [owner, count] of [
    ["apps/web", 4],
    ["packages/presets", 4],
    ["packages/ui", 2],
    ["packages/harness", 4],
    ["packages/local-runtime", 2],
  ] as const) {
    const suites = tasks.filter((task) => task.kind === "suite" && task.package === owner)
    expect(suites).toHaveLength(count)
    const specialized = tasks.filter((task) => task.kind !== "suite").flatMap((task) => task.files ?? [])
    const expected = (await collectTests("test", path.resolve(owner)))
      .filter((file) => !specialized.includes(`${owner}/${file}`))
      .sort()
    const observed = suites.flatMap((suite) => suite.files!)
    expect(observed.toSorted()).toEqual(expected)
    expect(new Set(observed).size).toBe(observed.length)
    for (const batch of suiteBatches(expected, path.resolve(owner), owner)) {
      expect(suites.filter((suite) => batch.files.some((file) => suite.files!.includes(file)))).toHaveLength(1)
    }
  }
})
