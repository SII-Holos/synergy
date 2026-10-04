import { expect, test } from "bun:test"
import { mergeModelDirectory } from "../../src/context/model-directory"
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
