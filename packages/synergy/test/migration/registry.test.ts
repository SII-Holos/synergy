import { describe, expect, test } from "bun:test"
// Side-effect import: registers all domain migrations in MigrationRegistry
import "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"

describe("MigrationRegistry", () => {
  test("registers all 5 domains", () => {
    const domainCount = MigrationRegistry.list().size
    expect(domainCount).toBe(5)
  })

  test("has expected domain names", () => {
    const domains = [...MigrationRegistry.list().keys()].sort()
    expect(domains).toEqual(["agenda", "config", "engram", "scope", "session"])
  })

  test("each domain has at least one migration", () => {
    for (const [domain, migrations] of MigrationRegistry.list()) {
      expect(migrations.length).toBeGreaterThan(0)
    }
  })

  test("all migrations have required id, description, and up function", () => {
    for (const [domain, migrations] of MigrationRegistry.list()) {
      for (const m of migrations) {
        expect(m.id, `${domain}: missing id`).toBeString()
        expect(m.id.length, `${domain}: empty id`).toBeGreaterThan(0)
        expect(m.description, `${domain}/${m.id}: missing description`).toBeString()
        expect(m.description.length, `${domain}/${m.id}: empty description`).toBeGreaterThan(0)
        expect(typeof m.up, `${domain}/${m.id}: missing up`).toBe("function")
      }
    }
  })

  test("all migration ids follow date prefix convention", () => {
    for (const [, migrations] of MigrationRegistry.list()) {
      for (const m of migrations) {
        expect(m.id).toMatch(/^\d{8}[a-z]?-/)
      }
    }
  })

  test("migration ids are unique across all domains", () => {
    const allIds = new Set<string>()
    for (const [, migrations] of MigrationRegistry.list()) {
      for (const m of migrations) {
        expect(allIds.has(m.id), `duplicate id: ${m.id}`).toBe(false)
        allIds.add(m.id)
      }
    }
  })
})
