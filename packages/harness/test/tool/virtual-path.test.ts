import { expect, test } from "bun:test"
import { BashVirtualPath } from "../../src/tool/virtual-path"
import { testRuntime } from "../support/runtime"

const source: BashVirtualPath.Source = {
  extension: ".txt",
  match: (value) => /^\/fixture\/artifact\/(\w+)$/.exec(value)?.[1],
  read: async (scope, id) => `${scope}:${id}`,
}

test("virtual file providers are selected per Runtime and sealed before use", async () => {
  await using selected = await testRuntime({
    register() {
      expect(() => BashVirtualPath.register("../invalid", source)).toThrow("Invalid virtual file provider")
      BashVirtualPath.register("artifact", source)
      expect(() => BashVirtualPath.register("artifact", source)).toThrow("Duplicate virtual file provider")
    },
  })
  await using bare = await testRuntime()
  await selected.run(async () => {
    expect(BashVirtualPath.match("/fixture/artifact/report")).toEqual({ provider: "artifact", id: "report" })
    expect(await BashVirtualPath.source("artifact").read("scope", "report")).toBe("scope:report")
    expect(BashVirtualPath.isShellCandidate("/fixture/artifact/report)")).toBe(true)
    expect(BashVirtualPath.match("/synergy/note/nte_fixture")).toBeUndefined()
    expect(() => BashVirtualPath.register("late", source)).toThrow("before opening the Runtime")
  })
  await bare.run(() => {
    expect(BashVirtualPath.match("/fixture/artifact/report")).toBeUndefined()
    expect(BashVirtualPath.match("/synergy/note/nte_fixture")).toBeUndefined()
    expect(() => BashVirtualPath.source("artifact")).toThrow("not registered")
  })
})
