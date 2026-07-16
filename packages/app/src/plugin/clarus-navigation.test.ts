import { describe, expect, test } from "bun:test"
import { listNavigation, getBuiltinNavigation } from "./registries/navigation-registry"
import "./builtin-navigation"

describe("Clarus built-in navigation", () => {
  test("registers /clarus as a sidebar navigation entry", () => {
    const entry = getBuiltinNavigation("clarus")
    expect(entry).toBeDefined()
    expect(entry!.id).toBe("clarus")
    expect(entry!.navigationId).toBe("clarus")
    expect(entry!.label).toBe("Clarus")
    expect(entry!.path).toBe("/clarus")
    expect(entry!.placement).toBe("sidebar")
  })

  test("references the clarus.main semantic icon token", () => {
    const entry = getBuiltinNavigation("clarus")
    expect(entry).toBeDefined()
    expect(entry!.iconToken).toBe("clarus.main")
    // iconToken must be a non-empty string that starts with "clarus."
    expect(entry!.iconToken!.startsWith("clarus.")).toBe(true)
    expect(entry!.iconToken!.length).toBeGreaterThan("clarus.".length)
  })

  test("provides a lazy loader that resolves to a NavigationContent component", async () => {
    const entry = getBuiltinNavigation("clarus")
    expect(entry).toBeDefined()
    expect(entry!.loader).toBeDefined()
    expect(typeof entry!.loader).toBe("function")

    const module = await entry!.loader!()
    expect(module).toBeDefined()
    expect(module.default).toBeDefined()
    expect(typeof module.default).toBe("function")
  })

  test("appears immediately after Home in the sidebar navigation ordering", () => {
    const sidebar = listNavigation("sidebar")
    const clarusIndex = sidebar.findIndex((e) => e.id === "clarus")
    expect(clarusIndex).toBeGreaterThanOrEqual(0)

    // Home is the default root and is not a nav entry — Clarus must be the
    // first sidebar entry, appearing before Agenda (order 10).
    const agendaEntry = sidebar.find((e) => e.id === "agenda")
    expect(agendaEntry).toBeDefined()
    expect(sidebar[clarusIndex]!.order!).toBeLessThan(agendaEntry!.order!)
  })

  test("is the first item in the sorted sidebar list", () => {
    const sidebar = listNavigation("sidebar")
    expect(sidebar.length).toBeGreaterThanOrEqual(1)
    expect(sidebar[0]!.id).toBe("clarus")
  })

  test("does not share an order value with any other sidebar entry", () => {
    const sidebar = listNavigation("sidebar")
    const orders = sidebar.filter((e) => e.id !== "clarus").map((e) => e.order)
    const clarusOrder = sidebar.find((e) => e.id === "clarus")!.order
    expect(orders).not.toContain(clarusOrder)
  })
})
