import { expect, test } from "bun:test"
import { createPluginGenerations } from "../../src/plugin/generations"
import { SlotRegistry } from "../../src/plugin/slot-registry"
import type { PluginContribution } from "../../src/plugin/api"

const plugin = (generation: string): PluginContribution => ({
  pluginId: "demo",
  name: "Demo",
  version: "1.0.0",
  scopeId: "a",
  generation,
  capabilities: [],
  contributions: [],
})

test("failed preparation retains the valid registration and later success replaces it once", async () => {
  const registry = new SlotRegistry()
  const released: string[] = []
  const errors: string[] = []
  const generations = createPluginGenerations({
    prepare: async (plugin) => {
      if (plugin.generation === "broken") throw new Error("invalid artifact")
      let uninstall = () => {}
      return {
        install() {
          uninstall = registry.register({ id: "demo:panel", slot: "panel", label: plugin.generation })
        },
        uninstall() {
          uninstall()
        },
        dispose() {
          released.push(plugin.generation)
        },
      }
    },
    changed() {},
    error(_plugin, error) {
      errors.push(String(error))
    },
  })
  await generations.reconcile([plugin("one")])
  const original = registry.get("demo:panel")
  await generations.reconcile([plugin("broken")])
  expect(registry.get("demo:panel")).toBe(original)
  expect(released).toEqual([])
  expect(errors).toEqual(["Error: invalid artifact"])
  await generations.reconcile([plugin("two")])
  expect(registry.get("demo:panel")?.label).toBe("two")
  expect(released).toEqual(["one"])
  await generations.reconcile([plugin("two")])
  expect(released).toEqual(["one"])
  generations.dispose()
  expect(registry.listAll()).toEqual([])
  expect(released).toEqual(["one", "two"])
})

test("late preparation cannot register after a newer reconcile or owner disposal", async () => {
  const pending = Promise.withResolvers<void>()
  const installed: string[] = []
  const released: string[] = []
  const generations = createPluginGenerations({
    prepare: async (plugin) => {
      if (plugin.generation === "slow") await pending.promise
      return {
        install() {
          installed.push(plugin.generation)
        },
        uninstall() {},
        dispose() {
          released.push(plugin.generation)
        },
      }
    },
    changed() {},
    error() {},
  })
  const old = generations.reconcile([plugin("slow")])
  await generations.reconcile([plugin("latest")])
  pending.resolve()
  await old
  expect(installed).toEqual(["latest"])
  expect(released).toEqual(["slow"])
  generations.dispose()
  await expect(generations.reconcile([plugin("after")])).rejects.toThrow("disposed")
  expect(installed).toEqual(["latest"])
})

test("cleanup failures cannot roll back a successful generation or strand other plugins", async () => {
  const installed = new Map<string, string>()
  const disposed: string[] = []
  const errors: unknown[] = []
  const generations = createPluginGenerations({
    async prepare(plugin) {
      return {
        install() {
          installed.set(plugin.pluginId, plugin.generation)
        },
        uninstall() {
          installed.delete(plugin.pluginId)
        },
        dispose() {
          disposed.push(plugin.generation)
          if (plugin.generation === "one") throw new Error("cleanup failed")
        },
      }
    },
    changed() {},
    error(_plugin, error) {
      errors.push(error)
    },
  })
  await generations.reconcile([plugin("one"), { ...plugin("other"), pluginId: "other" }])
  await generations.reconcile([plugin("two"), { ...plugin("other"), pluginId: "other" }])
  expect(installed.get("demo")).toBe("two")
  generations.dispose()
  expect(installed.size).toBe(0)
  expect(disposed.toSorted()).toEqual(["one", "other", "two"])
  expect(errors).toHaveLength(1)
})

test("verified Scope generations survive navigation discovery and change only for that Scope", async () => {
  const { createPluginScopeVersions } = await import("../../src/plugin/generations")
  const versions = createPluginScopeVersions()
  const first = [plugin("one")]
  versions.accept("server", "a", first)
  const a = versions.get("server", "a")
  expect(a).not.toBe(versions.get("server", "b"))
  versions.accept("server", "b", [{ ...plugin("different"), scopeId: "b" }])
  expect(versions.get("server", "a")).toBe(a)
  versions.accept("server", "a", first)
  expect(versions.get("server", "a")).toBe(a)
  versions.accept("server", "a", [{ ...plugin("one"), capabilities: ["session.read"] }])
  expect(versions.get("server", "a")).not.toBe(a)
  versions.accept("server", "a", [])
  expect(versions.get("server", "a")).toBe("[]")
  versions.clear()
  expect(versions.get("server", "b")).toBe("[]")
})
