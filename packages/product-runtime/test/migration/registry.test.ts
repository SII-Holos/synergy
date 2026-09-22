import { describe, expect, test } from "bun:test"
// Side-effect imports: the L1 runner registers its own domains; product domains
// register through the L4 product manifest that real entry points load.
import "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("MigrationRegistry", () => {
  test("registers all domains", () =>
    runtime.run(() => {
      const domainCount = MigrationRegistry.list().size
      expect(domainCount).toBe(14)
    }))

  test("has expected domain names", () =>
    runtime.run(() => {
      const domains = [...MigrationRegistry.list().keys()].sort()
      expect(domains).toEqual([
        "agenda",
        "blueprint_loop",
        "browser",
        "config",
        "holos",
        "lattice",
        "library",
        "note",
        "observability",
        "plugin_catalog",
        "scope",
        "session",
        "storage",
        "workflows-session",
      ])
    }))

  test("each domain has at least one migration", () =>
    runtime.run(() => {
      for (const [domain, migrations] of MigrationRegistry.list()) {
        expect(migrations.length).toBeGreaterThan(0)
      }
    }))

  test("all migrations have required id, description, and up function", () =>
    runtime.run(() => {
      for (const [domain, migrations] of MigrationRegistry.list()) {
        for (const m of migrations) {
          expect(m.id, `${domain}: missing id`).toBeString()
          expect(m.id.length, `${domain}: empty id`).toBeGreaterThan(0)
          expect(m.description, `${domain}/${m.id}: missing description`).toBeString()
          expect(m.description.length, `${domain}/${m.id}: empty description`).toBeGreaterThan(0)
          expect(typeof m.up, `${domain}/${m.id}: missing up`).toBe("function")
        }
      }
    }))

  test("all migration ids follow date prefix convention", () =>
    runtime.run(() => {
      for (const [, migrations] of MigrationRegistry.list()) {
        for (const m of migrations) {
          expect(m.id).toMatch(/^\d{8}[a-z]?-/)
        }
      }
    }))

  test("migration ids are unique across all domains", () =>
    runtime.run(() => {
      const allIds = new Set<string>()
      for (const [, migrations] of MigrationRegistry.list()) {
        for (const m of migrations) {
          expect(allIds.has(m.id), `duplicate id: ${m.id}`).toBe(false)
          allIds.add(m.id)
        }
      }
    }))
})

afterRuntimeTests(() => runtime.close())
