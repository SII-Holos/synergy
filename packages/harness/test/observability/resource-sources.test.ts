import { expect, test } from "bun:test"
import { ResourceSources } from "../../src/observability/resource-sources"
import { testRuntime } from "../support/runtime"

test("resource providers are read only by their owning Runtime and close independently", async () => {
  let reads = 0
  await using core = await testRuntime()
  const extended = await testRuntime({
    register() {
      ResourceSources.register("fixture", () => {
        reads++
        return {
          owner: "mcp",
          processCount: 1,
          measuredProcessCount: 1,
          currentBytes: 42,
          source: "mcp_stdio",
          completeness: "full",
          attributes: {},
        }
      })
    },
  })
  try {
    expect(await core.run(() => ResourceSources.read())).toEqual([])
    expect(reads).toBe(0)
    expect((await extended.run(() => ResourceSources.read()))[0]?.currentBytes).toBe(42)
    expect(reads).toBe(1)
    await extended.run(() =>
      expect(() =>
        ResourceSources.register("late", () => {
          throw new Error("unreachable")
        }),
      ).toThrow(),
    )
  } finally {
    await extended.close()
  }
  expect(await core.run(() => ResourceSources.read())).toEqual([])
  expect(reads).toBe(1)
})
