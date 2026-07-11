import { describe, expect, test } from "bun:test"
import { PluginRuntimeRegistry, pluginRuntimeKey, type PluginRuntimeEntry } from "../../src/plugin-runtime/registry"

function entry(version: string, generation: string): PluginRuntimeEntry {
  return {
    key: pluginRuntimeKey("research", version, generation),
    pluginId: "research",
    version,
    generation,
    mode: "process",
    state: "ready",
    handlerIds: [],
    inFlight: 0,
    startedAt: Date.now(),
  }
}

describe("PluginRuntimeRegistry", () => {
  test("atomically swaps the one active generation for a plugin", () => {
    const registry = new PluginRuntimeRegistry()
    const first = entry("1.0.0", "one")
    const second = entry("1.1.0", "two")
    registry.set(first)
    registry.set(second)

    expect(registry.activate(first.key)).toBeUndefined()
    expect(registry.active("research")?.generation).toBe("one")
    expect(registry.activate(second.key)?.generation).toBe("one")
    expect(registry.active("research")?.generation).toBe("two")
  })
})
