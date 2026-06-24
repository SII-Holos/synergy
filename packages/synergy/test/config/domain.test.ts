import { expect, test } from "bun:test"
import { ConfigDomain } from "../../src/config/domain"
import { Config } from "../../src/config/config"

test("config domain registry maps every top-level config key exactly once", () => {
  expect(() => ConfigDomain.assertRegistryComplete()).not.toThrow()

  const schemaKeys = Object.keys(Config.Info.shape).sort()
  const domainKeys = ConfigDomain.definitions.flatMap((domain) => domain.ownedKeys.map(String)).sort()

  expect(domainKeys).toEqual(schemaKeys)
  expect(new Set(domainKeys).size).toBe(domainKeys.length)
})

test("config domain filenames are stable and ordered", () => {
  expect(ConfigDomain.definitions.map((domain) => domain.filename)).toEqual([
    "00-general.jsonc",
    "10-models.jsonc",
    "20-providers.jsonc",
    "30-library.jsonc",
    "40-mcp.jsonc",
    "50-plugins.jsonc",
    "60-agents.jsonc",
    "70-commands.jsonc",
    "80-permissions.jsonc",
    "90-channels.jsonc",
    "100-holos.jsonc",
    "110-email.jsonc",
    "120-runtime.jsonc",
  ])
})
