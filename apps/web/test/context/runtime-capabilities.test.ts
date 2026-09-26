import { describe, expect, test } from "bun:test"
import type { RuntimeCapabilities } from "@ericsanchezok/synergy-sdk"
import { createRuntimeCapabilities } from "../../src/context/runtime-capabilities"
import { runtimeFeatureAvailable } from "../../src/components/runtime-features"

const snapshot = (...ids: string[]): RuntimeCapabilities => ({
  apiVersion: 1,
  hostVersion: "2.0.0",
  components: ids.map((id) => ({ id, version: "2.0.0", apiVersion: 1 })),
})

describe("runtime capabilities", () => {
  test("shares discovery and keeps optional features unavailable until confirmed", async () => {
    let calls = 0
    let complete!: (value: RuntimeCapabilities) => void
    const capabilities = createRuntimeCapabilities(() => {
      calls++
      return new Promise((resolve) => (complete = resolve))
    })
    expect(capabilities.has("mcp")).toBe(false)
    const first = capabilities.load()
    const second = capabilities.load()
    expect(calls).toBe(1)
    complete(snapshot("server", "mcp"))
    await Promise.all([first, second])
    expect(capabilities.has("mcp")).toBe(true)
    expect(capabilities.has("connections")).toBe(false)
    await capabilities.load()
    expect(calls).toBe(1)
  })

  test("a reconnect ignores an older discovery result and retries failed discovery", async () => {
    const pending: Array<(value: RuntimeCapabilities) => void> = []
    const capabilities = createRuntimeCapabilities(() => new Promise((resolve) => pending.push(resolve)))
    const old = capabilities.load()
    capabilities.reset()
    const current = capabilities.load()
    pending[1](snapshot("server", "lsp"))
    await current
    pending[0](snapshot("server", "mcp"))
    await old
    expect(capabilities.has("mcp")).toBe(false)
    expect(capabilities.has("lsp")).toBe(true)

    let attempt = 0
    const retry = createRuntimeCapabilities(async () => {
      if (!attempt++) throw new Error("offline")
      return snapshot("server")
    })
    await expect(retry.load()).rejects.toThrow("offline")
    expect(retry.has("server")).toBe(false)
    await retry.load()
    expect(retry.has("server")).toBe(true)
  })

  test("core, selective, and full compositions expose only their owned surfaces", async () => {
    const capabilities = createRuntimeCapabilities(async () => snapshot("server", "mcp", "library"))
    await capabilities.load()
    expect(runtimeFeatureAvailable("settings", "mcp", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("settings", "account", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("settings", "permissions", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("settings", "voice", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("navigation", "library", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("navigation", "agenda", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("panel", "browser", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("panel", "file", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("panel", "vendor:notes", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("navigation", "performance", () => true)).toBe(true)
  })
})
