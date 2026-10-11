import { expect, test } from "bun:test"
import { MigrationPlan } from "../../src/migration/plan"
import type { Migration } from "../../src/migration/types"

function migration(id: string, dependsOn?: string[]): Migration {
  return { id, dependsOn, description: id, execution: "startup", async up() {} }
}

test("registered migrations follow cross-domain dependencies instead of domain names", () => {
  const ordered = MigrationPlan.ordered(
    new Map([
      ["a", [migration("second", ["z/first"])]],
      ["z", [migration("first")]],
    ]),
  )
  expect(ordered.map((entry) => entry.domain)).toEqual(["z", "a"])
})

test("missing, duplicate and self-dependent registrations fail before work", () => {
  expect(() => MigrationPlan.ordered(new Map([["a", [migration("one", ["missing"])]]]))).toThrow("missing dependency")
  expect(() => MigrationPlan.ordered(new Map([["a", [migration("one"), migration("one")]]]))).toThrow("Duplicate")
  expect(() => MigrationPlan.ordered(new Map([["a", [migration("one", ["one"])]]]))).toThrow("Cycle")
})

test("new migrations cannot silently inherit startup execution", () => {
  expect(() =>
    MigrationPlan.ordered(new Map([["a", [{ ...migration("20261008-history"), execution: undefined }]]])),
  ).toThrow("execution policy")
  expect(MigrationPlan.ordered(new Map([["a", [migration("20261008-history")]]]))).toHaveLength(1)
})

test("an unknown shared migration remains a barrier and deferred dependencies cannot admit startup", () => {
  expect(MigrationPlan.separable({ ...migration("unknown"), execution: undefined })).toBe(false)
  expect(() =>
    MigrationPlan.ordered(
      new Map([["a", [{ ...migration("later"), execution: "maintenance" }, migration("early", ["later"])]]]),
    ),
  ).toThrow("deferred dependency")
})
