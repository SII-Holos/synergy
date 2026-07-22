import { describe, expect, test } from "bun:test"
import { createPluginSurfaceSettings } from "./surface-settings"

describe("trusted plugin surface settings", () => {
  test("reads and replaces only the owning plugin settings in the active Scope", async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const client = {
      plugin: {
        async getConfig(input: unknown) {
          calls.push({ method: "get", input })
          return { data: { layout: "grid" } }
        },
        async updateConfig(input: unknown) {
          calls.push({ method: "replace", input })
          return { data: { layout: "dense", normalized: true } }
        },
      },
    }
    const events = new EventTarget()
    const settings = createPluginSurfaceSettings({
      client,
      pluginId: "frontend-kit",
      scopeId: "scope-project",
      canWrite: true,
      events,
    })
    const observed: Record<string, unknown>[] = []
    const unsubscribe = settings.subscribe((values: Record<string, unknown>) => observed.push(values))

    await expect(settings.get()).resolves.toEqual({ layout: "grid" })
    await expect(settings.replace({ layout: "dense" })).resolves.toBeUndefined()
    unsubscribe()

    expect(calls).toEqual([
      {
        method: "get",
        input: { pluginId: "frontend-kit", scopeID: "scope-project" },
      },
      {
        method: "replace",
        input: {
          pluginId: "frontend-kit",
          scopeID: "scope-project",
          pluginConfigUpdate: { layout: "dense" },
        },
      },
    ])
    expect(observed).toEqual([{ layout: "dense", normalized: true }])
  })

  test("ignores settings events from another plugin or Scope", () => {
    const events = new EventTarget()
    const settings = createPluginSurfaceSettings({
      client: {
        plugin: {
          async getConfig() {
            return { data: {} }
          },
          async updateConfig() {
            return { data: {} }
          },
        },
      },
      pluginId: "frontend-kit",
      scopeId: "scope-project",
      events,
    })
    const observed: Record<string, unknown>[] = []
    const unsubscribe = settings.subscribe((values: Record<string, unknown>) => observed.push(values))

    events.dispatchEvent(
      new CustomEvent("synergy:plugin-config-changed", {
        detail: { pluginId: "other", scopeId: "scope-project", values: { layout: "other" } },
      }),
    )
    events.dispatchEvent(
      new CustomEvent("synergy:plugin-config-changed", {
        detail: { pluginId: "frontend-kit", scopeId: "scope-home", values: { layout: "home" } },
      }),
    )
    unsubscribe()

    expect(observed).toEqual([])
  })

  test("fails closed when settings.write is not approved", async () => {
    let updated = false
    const settings = createPluginSurfaceSettings({
      client: {
        plugin: {
          async getConfig() {
            return { data: {} }
          },
          async updateConfig() {
            updated = true
            return { data: {} }
          },
        },
      },
      pluginId: "frontend-kit",
      scopeId: "scope-project",
      canWrite: false,
      events: new EventTarget(),
    })

    await expect(settings.replace({ layout: "dense" })).rejects.toThrow("settings.write")
    expect(updated).toBe(false)
  })
})
