import { expect, test } from "bun:test"
import { selectComponents } from "../../src/component-selection"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

test("CLI selection includes declared requirements and fails on unavailable or malformed selections", () => {
  const base = { version: "2.0.0", apiVersion: 1 as const, register() {} }
  const all: RuntimeComponent[] = [
    { ...base, id: "mcp", requires: { "plugin-host": "2.0.0" } },
    { ...base, id: "server" },
    { ...base, id: "web-app", requires: { server: "2.0.0" } },
  ]
  expect(selectComponents(all, '{"web-app":"2.0.0"}')).toEqual([all[1], all[2]])
  expect(selectComponents(all, '{"mcp":"2.0.0"}')).toEqual([all[0]])
  expect(selectComponents(all, "{}")).toEqual([])
  expect(selectComponents(all)).toEqual(all)
  expect(() => selectComponents(all, '{"missing":"2.0.0"}')).toThrow("not installed")
  expect(() => selectComponents(all, '{"server":true}')).toThrow()
  expect(() => selectComponents(all, '{"server":"1.0.0"}')).toThrow("exact version")
})
