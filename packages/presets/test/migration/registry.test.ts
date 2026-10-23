import { describe, expect, test } from "bun:test"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime({ desktop: true, optIn: ["boss", "lattice"] })

describe("MigrationRegistry", () => {
  test("registers all domains", () =>
    runtime.run(() => {
      const domainCount = MigrationRegistry.list().size
      expect(domainCount).toBe(37)
      expect(MigrationRegistry.list().get("session")).toContainEqual(
        expect.objectContaining({
          domain: "rollout-journal",
          execution: "maintenance",
          scope: "derived",
        }),
      )
    }))

  test("has expected domain names", () =>
    runtime.run(() => {
      const domains = [...MigrationRegistry.list().keys()].sort()
      expect(domains).toEqual([
        "agenda",
        "anima",
        "blueprint-note",
        "blueprint-session",
        "blueprint_loop",
        "boss-config",
        "browser",
        "channel",
        "channel-clarus",
        "config",
        "digital-twin",
        "environment",
        "holos",
        "installation",
        "lattice",
        "lattice-session",
        "library",
        "light-loop-session",
        "local-workspace",
        "mcp-config",
        "note",
        "observability",
        "plugin-config",
        "plugin_catalog",
        "scope",
        "session",
        "storage",
        "tool-input-agenda",
        "tool-input-browser",
        "tool-input-cortex",
        "tool-input-library",
        "tool-input-local-runtime",
        "tool-input-media",
        "tool-input-note",
        "usage",
        "workbench-projects",
        "workspace",
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
