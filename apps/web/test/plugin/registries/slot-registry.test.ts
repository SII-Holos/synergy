import { describe, expect, test } from "bun:test"
import { SlotRegistry, type SlotEntry } from "../../../src/plugin/slot-registry"

function entry(overrides: Partial<SlotEntry>): SlotEntry {
  return {
    id: "test:entry",
    label: "Test entry",
    slot: "sidebar.footer",
    pluginId: "test",
    loader: async () => ({ default: () => null }),
    ...overrides,
  }
}

function freshRegistry() {
  return new SlotRegistry<SlotEntry>()
}

describe("slot registry", () => {
  test("registers entries per slot and lists them in stable order", () => {
    const registry = freshRegistry()
    const unregisterB = registry.register(entry({ id: "test:b", label: "B", order: 20 }))
    const unregisterA = registry.register(entry({ id: "test:a", label: "A", order: 10 }))
    const unregisterC = registry.register(entry({ id: "test:c", label: "C", slot: "other" }))

    expect(registry.list("sidebar.footer").map((e) => e.id)).toEqual(["test:a", "test:b"])
    expect(registry.list("other").map((e) => e.id)).toEqual(["test:c"])
    expect(registry.list("missing")).toEqual([])

    unregisterA()
    unregisterB()
    unregisterC()
  })

  test("disposer is idempotent and removes only its own entry", () => {
    const registry = freshRegistry()
    const unregisterA = registry.register(entry({ id: "test:a" }))
    const unregisterB = registry.register(entry({ id: "test:b" }))

    unregisterA()
    unregisterA()
    expect(registry.list("sidebar.footer").map((e) => e.id)).toEqual(["test:b"])

    unregisterB()
    expect(registry.list("sidebar.footer")).toEqual([])
  })

  test("rejects duplicate ids within the same slot", () => {
    const registry = freshRegistry()
    const unregister = registry.register(entry({ id: "test:dup" }))
    expect(() => registry.register(entry({ id: "test:dup" }))).toThrow(/Duplicate slot entry/)
    unregister()
  })

  test("allows the same id in different slots", () => {
    const registry = freshRegistry()
    const unregisterA = registry.register(entry({ id: "test:shared", slot: "sidebar.footer" }))
    const unregisterB = registry.register(entry({ id: "test:shared", slot: "session.empty" }))
    expect(registry.list("sidebar.footer")).toHaveLength(1)
    expect(registry.list("session.empty")).toHaveLength(1)
    unregisterA()
    unregisterB()
  })

  test("clear scoped to one plugin removes only that plugin's entries", () => {
    const registry = freshRegistry()
    const unregisterA = registry.register(entry({ id: "test:a", pluginId: "test" }))
    const unregisterB = registry.register(entry({ id: "other:b", pluginId: "other" }))

    registry.clear("test")
    expect(registry.list("sidebar.footer").map((e) => e.id)).toEqual(["other:b"])

    registry.clear()
    expect(registry.list("sidebar.footer")).toEqual([])
    unregisterA()
    unregisterB()
  })

  test("notifies subscribers on register and unregister", () => {
    const registry = freshRegistry()
    let notifications = 0
    const unsubscribe = registry.subscribe(() => notifications++)
    const unregister = registry.register(entry({ id: "test:notify" }))
    expect(notifications).toBe(1)
    unregister()
    expect(notifications).toBe(2)
    unsubscribe()
  })

  test("unsubscribe stops notifications", () => {
    const registry = freshRegistry()
    let notifications = 0
    const unsubscribe = registry.subscribe(() => notifications++)
    unsubscribe()
    registry.register(entry({ id: "test:no-notify" }))
    expect(notifications).toBe(0)
    registry.clear()
  })

  test("shared pluginSlots instance is a SlotRegistry", async () => {
    const { pluginSlots } = await import("../../../src/plugin/slot-registry")
    expect(pluginSlots).toBeInstanceOf(SlotRegistry)
    const unregister = pluginSlots.register(entry({ id: "shared:probe", slot: "probe.slot" }))
    expect(pluginSlots.list("probe.slot")).toHaveLength(1)
    unregister()
  })
})
