import { describe, expect, test } from "bun:test"
import { validateRuntimeDiscovery } from "../../src/plugin/validate-runtime-discovery"

describe("validateRuntimeDiscovery", () => {
  test("returns empty result when all runtime tools are declared in manifest", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["my-tool", "search-tool"],
      runtimeToolNames: ["my-tool", "search-tool"],
      pluginId: "test-plugin",
    })
    expect(result.valid).toBe(true)
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toEqual(["my-tool", "search-tool"])
  })

  test("detects undeclared tools registered at runtime but not in manifest", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["declared-tool"],
      runtimeToolNames: ["declared-tool", "secret-tool", "hidden-tool"],
      pluginId: "bad-plugin",
    })
    expect(result.valid).toBe(false)
    expect(result.undeclared).toEqual(["secret-tool", "hidden-tool"])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toEqual(["declared-tool"])
  })

  test("detects declared tools that are not registered at runtime", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["alpha", "beta", "gamma"],
      runtimeToolNames: ["alpha"],
      pluginId: "partial-plugin",
    })
    expect(result.valid).toBe(true) // missing runtime registration is a warning, not an error
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual(["beta", "gamma"])
    expect(result.matched).toEqual(["alpha"])
  })

  test("handles complete load failure — manifest declares tools but none registered", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["tool-a", "tool-b", "tool-c"],
      runtimeToolNames: [],
      pluginId: "broken-plugin",
    })
    expect(result.valid).toBe(true) // no undeclared tools, just unregistered
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual(["tool-a", "tool-b", "tool-c"])
    expect(result.matched).toEqual([])
  })

  test("handles both undeclared and missing at the same time", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["declared-a", "declared-b"],
      runtimeToolNames: ["declared-a", "undeclared-x", "undeclared-y"],
      pluginId: "messy-plugin",
    })
    expect(result.valid).toBe(false)
    expect(result.undeclared).toEqual(["undeclared-x", "undeclared-y"])
    expect(result.declaredButMissing).toEqual(["declared-b"])
    expect(result.matched).toEqual(["declared-a"])
  })

  test("handles empty manifest tools and no runtime tools", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: [],
      runtimeToolNames: [],
      pluginId: "empty-plugin",
    })
    expect(result.valid).toBe(true)
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toEqual([])
  })

  test("handles no manifest tools but runtime has tools", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: [],
      runtimeToolNames: ["runtime-only-tool"],
      pluginId: "no-manifest-tools",
    })
    expect(result.valid).toBe(false)
    expect(result.undeclared).toEqual(["runtime-only-tool"])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toEqual([])
  })

  test("handles no runtime tools available (null) — load failure variant", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["declared-tool"],
      runtimeToolNames: null,
      pluginId: "failed-plugin",
    })
    expect(result.valid).toBe(true)
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual([])
    expect(result.loadFailed).toBe(true)
    expect(result.matched).toEqual([])
  })

  test("correctly handles exact match with single tool", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["solo-tool"],
      runtimeToolNames: ["solo-tool"],
      pluginId: "solo-plugin",
    })
    expect(result.valid).toBe(true)
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toEqual(["solo-tool"])
  })

  test("ignores order — tools match regardless of array ordering", () => {
    const result = validateRuntimeDiscovery({
      manifestToolNames: ["z-tool", "a-tool", "m-tool"],
      runtimeToolNames: ["m-tool", "z-tool", "a-tool"],
      pluginId: "shuffled-plugin",
    })
    expect(result.valid).toBe(true)
    expect(result.undeclared).toEqual([])
    expect(result.declaredButMissing).toEqual([])
    expect(result.matched).toHaveLength(3)
    expect(result.matched.sort()).toEqual(["a-tool", "m-tool", "z-tool"])
  })
})
