import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { testRuntime } from "../support/runtime"

for (const [count, readers] of [
  [1300, 1],
  [230, 8],
]) {
  test(`lists ${count} stored projects for ${readers} concurrent readers without exhausting admission`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const projects: Scope.Project[] = Array.from({ length: count }, (_, index) => ({
        type: "project",
        id: `project-${String(index).padStart(4, "0")}`,
        name: `Project ${index}`,
        local: null,
        time: { created: index + 1, updated: index + 1, ...(index >= 20 ? { archived: 1 } : {}) },
      }))
      await Storage.transaction((tx) =>
        tx.writeMany(projects.map((value) => ({ key: StoragePath.scope(Identifier.asScopeID(value.id)), value }))),
      )
      const results = await Promise.allSettled(Array.from({ length: readers }, () => Scope.list()))
      expect(results.filter((result) => result.status === "rejected")).toEqual([])
      for (const result of results) {
        if (result.status !== "fulfilled") continue
        expect(result.value).toEqual(projects.slice(0, 20))
      }
      expect(await Scope.fromID(projects.at(-1)!.id)).toEqual(projects.at(-1)!)
      expect(await Scope.listScopeIDs()).toHaveLength(count)
    })
  })
}
