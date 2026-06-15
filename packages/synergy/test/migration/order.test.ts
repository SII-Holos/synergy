import { describe, expect, test } from "bun:test"
import { orderMigrations, CycleError } from "../../src/migration/order"
import type { Migration } from "../../src/migration/types"

function makeMig(overrides: Partial<Migration> & { id: string }): Migration {
  return {
    description: `Migration ${overrides.id}`,
    async up(_progress) {},
    ...overrides,
  }
}

describe("orderMigrations", () => {
  test("lexical sort by id when no dependencies or versions", () => {
    const migrations = [makeMig({ id: "ccc" }), makeMig({ id: "aaa" }), makeMig({ id: "bbb" })]
    const result = orderMigrations(migrations)
    expect(result.map((m) => m.id)).toEqual(["aaa", "bbb", "ccc"])
  })

  test("single migration passes through", () => {
    const migrations = [makeMig({ id: "only" })]
    const result = orderMigrations(migrations)
    expect(result.map((m) => m.id)).toEqual(["only"])
  })

  test("empty list passes through", () => {
    const result = orderMigrations([])
    expect(result).toEqual([])
  })

  test("dependsOn: A→B means B runs before A", () => {
    const a = makeMig({ id: "a", dependsOn: ["b"] })
    const b = makeMig({ id: "b" })
    const result = orderMigrations([a, b])
    expect(result.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("dependsOn: chain B→C→A", () => {
    const a = makeMig({ id: "a", dependsOn: ["b"] })
    const b = makeMig({ id: "b", dependsOn: ["c"] })
    const c = makeMig({ id: "c" })
    // Input in reverse order
    const result = orderMigrations([a, b, c])
    expect(result.map((m) => m.id)).toEqual(["c", "b", "a"])
  })

  test("multiple dependencies per migration", () => {
    const a = makeMig({ id: "a", dependsOn: ["b", "c"] })
    const b = makeMig({ id: "b" })
    const c = makeMig({ id: "c" })
    const result = orderMigrations([a, b, c])
    expect(result.findIndex((m) => m.id === "a")).toBeGreaterThan(result.findIndex((m) => m.id === "b"))
    expect(result.findIndex((m) => m.id === "a")).toBeGreaterThan(result.findIndex((m) => m.id === "c"))
  })

  test("version sort: semver ascending", () => {
    const m1 = makeMig({ id: "z-migration", version: "3.0.0" })
    const m2 = makeMig({ id: "a-migration", version: "1.0.0" })
    const m3 = makeMig({ id: "x-migration", version: "2.0.0" })
    const result = orderMigrations([m1, m2, m3])
    expect(result.map((m) => m.id)).toEqual(["a-migration", "x-migration", "z-migration"])
  })

  test("version sort: 2.0 > 1.10 numerically (not lexically)", () => {
    const m1 = makeMig({ id: "a", version: "1.10.0" })
    const m2 = makeMig({ id: "b", version: "2.0.0" })
    const m3 = makeMig({ id: "c", version: "1.2.0" })
    const result = orderMigrations([m2, m3, m1])
    expect(result.map((m) => m.id)).toEqual(["c", "a", "b"])
  })

  test("dependsOn overrides version sort", () => {
    const a = makeMig({ id: "a", version: "3.0.0", dependsOn: ["b"] })
    const b = makeMig({ id: "b", version: "1.0.0" })
    const result = orderMigrations([a, b])
    expect(result.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("cycle detection: A→B→A throws CycleError", () => {
    const a = makeMig({ id: "a", dependsOn: ["b"] })
    const b = makeMig({ id: "b", dependsOn: ["a"] })
    expect(() => orderMigrations([a, b])).toThrow()
    try {
      orderMigrations([a, b])
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).message).toContain("Cycle")
    }
  })

  test("cycle detection: self-reference in multi-migration set throws", () => {
    const a = makeMig({ id: "a", dependsOn: ["a"] })
    const b = makeMig({ id: "b" })
    expect(() => orderMigrations([a, b])).toThrow()
    try {
      orderMigrations([a, b])
      expect.unreachable("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).message).toContain("Cycle")
    }
  })

  test("dependsOn references not in batch are silently skipped", () => {
    const a = makeMig({ id: "a", dependsOn: ["nonexistent"] })
    const b = makeMig({ id: "b" })
    const result = orderMigrations([a, b])
    // 'a' depends on something not in batch - the dep is skipped,
    // so ordering falls back to version/lexical
    expect(result).toHaveLength(2)
  })

  test("mix: dependsOn first, then version, then lexical", () => {
    // deps: d1 depends on base1; d2 depends on base2
    // versions: base2@0.5.0 should sort before base1@1.0.0
    const base1 = makeMig({ id: "base-1", version: "1.0.0" })
    const base2 = makeMig({ id: "base-2", version: "0.5.0" })
    const d1 = makeMig({ id: "dep-1", version: "3.0.0", dependsOn: ["base-1"] })
    const d2 = makeMig({ id: "dep-2", version: "0.1.0", dependsOn: ["base-2"] })
    const result = orderMigrations([d2, d1, base1, base2])
    expect(result.findIndex((m) => m.id === "base-1")).toBeLessThan(result.findIndex((m) => m.id === "dep-1"))
    expect(result.findIndex((m) => m.id === "base-2")).toBeLessThan(result.findIndex((m) => m.id === "dep-2"))
    expect(result.findIndex((m) => m.id === "base-2")).toBeLessThan(result.findIndex((m) => m.id === "base-1"))
  })
})
