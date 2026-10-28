import { describe, expect, test } from "bun:test"
import type { RuntimeCapabilities } from "@ericsanchezok/synergy-sdk"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createRuntimeCapabilities, discoverRuntimeCapabilities } from "../../src/context/runtime-capabilities"
import { runtimeFeatureAvailable } from "../../src/components/runtime-features"

const snapshot = (...ids: string[]): RuntimeCapabilities => ({
  apiVersion: 1,
  hostVersion: "2.0.0",
  components: [{ id: "product-bundle", version: "2.0.0", apiVersion: 1 }],
  features: ids,
})

describe("runtime capabilities", () => {
  test("the generated client retries startup 503 while keeping features hidden", async () => {
    let calls = 0
    const client = createSynergyClient({
      baseUrl: "http://fixture",
      fetch: Object.assign(
        async () => {
          calls++
          return calls === 1
            ? Response.json({ error: "Runtime services are not ready" }, { status: 503 })
            : Response.json(snapshot("note"))
        },
        { preconnect() {} },
      ),
    })
    const capabilities = createRuntimeCapabilities((signal) => discoverRuntimeCapabilities(client, signal))
    const ready = capabilities.load()
    expect(capabilities.has("note")).toBe(false)
    await ready
    expect(calls).toBe(2)
    expect(capabilities.has("note")).toBe(true)
    capabilities.dispose()
  })

  test("an owner reset cancels startup retries and disposal cannot start discovery again", async () => {
    let calls = 0
    const client = createSynergyClient({
      baseUrl: "http://fixture",
      fetch: Object.assign(
        async () => {
          calls++
          return Response.json({ error: "Runtime services are not ready" }, { status: 503 })
        },
        { preconnect() {} },
      ),
    })
    const capabilities = createRuntimeCapabilities((signal) => discoverRuntimeCapabilities(client, signal))
    const ready = capabilities.load()
    await Bun.sleep(20)
    capabilities.reset()
    await ready
    await Bun.sleep(550)
    expect(calls).toBe(1)
    capabilities.dispose()
    await capabilities.load()
    expect(calls).toBe(1)
    expect(capabilities.current()).toBeUndefined()
  })

  test("non-startup errors preserve their structured response without retry", async () => {
    let calls = 0
    const client = createSynergyClient({
      baseUrl: "http://fixture",
      fetch: Object.assign(
        async () => {
          calls++
          return Response.json({ error: "Denied" }, { status: 403 })
        },
        { preconnect() {} },
      ),
    })
    const capabilities = createRuntimeCapabilities((signal) => discoverRuntimeCapabilities(client, signal))
    await expect(capabilities.load()).rejects.toEqual({ error: "Denied" })
    expect(calls).toBe(1)
    capabilities.dispose()
  })

  test("transport failures keep their original error for the connection retry policy", async () => {
    const error = new TypeError("Failed to fetch")
    const client = createSynergyClient({
      baseUrl: "http://fixture",
      fetch: Object.assign(
        async () => {
          throw error
        },
        { preconnect() {} },
      ),
    })
    const capabilities = createRuntimeCapabilities((signal) => discoverRuntimeCapabilities(client, signal))
    await expect(capabilities.load()).rejects.toBe(error)
    capabilities.dispose()
  })

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
    const capabilities = createRuntimeCapabilities(async () => snapshot("mcp", "library", "agenda"))
    await capabilities.load()
    expect(runtimeFeatureAvailable("settings", "mcp", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("settings", "channels", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("settings", "permissions", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("settings", "voice", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("navigation", "library", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("navigation", "agenda", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("panel", "browser", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("panel", "file", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("panel", "vendor:notes", capabilities.has)).toBe(true)
    expect(runtimeFeatureAvailable("navigation", "performance", () => true)).toBe(true)
    expect(capabilities.has("product-bundle")).toBe(false)
    expect(runtimeFeatureAvailable("navigation", "plugins", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("panel", "notes", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("settings", "worktrees", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("workflow", "blueprint", capabilities.has)).toBe(false)
    expect(runtimeFeatureAvailable("workflow", "plan", capabilities.has)).toBe(false)
  })
})
