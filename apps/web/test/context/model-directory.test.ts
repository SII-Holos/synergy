import { expect, test } from "bun:test"
import { mergeModelDirectory, mergeProviderSelection } from "../../src/context/model-directory"
import type { ProviderDirectoryPage, ProviderSelection } from "@ericsanchezok/synergy-sdk/client"

const base: ProviderSelection = {
  all: [],
  connected: [],
  default: {},
  profiles: {},
  configProviders: [],
  catalogProviders: [],
  connections: {},
  authHealth: {},
  runtimeAvailability: {},
  modelCatalog: {},
  complete: false,
  version: "one",
}
test("a late model page cannot enter a newer Scope model directory", () => {
  const page: ProviderDirectoryPage = { version: "old", models: [], total: 0 }
  expect(mergeModelDirectory(base, page)).toBe(base)
  expect(mergeModelDirectory(base, { ...page, version: "one" })).not.toBe(base)
})

test("selection refresh retains resolved models only within the same directory version", () => {
  const current = { ...base, resolvedModels: ['["fixture","missing"]'] }
  expect(mergeProviderSelection(current, base).resolvedModels).toEqual(current.resolvedModels)
  const changed = { ...base, version: "two" }
  expect(mergeProviderSelection(current, changed)).toBe(changed)
  const complete = { ...base, complete: true }
  expect(mergeProviderSelection(current, complete)).toBe(complete)
})
