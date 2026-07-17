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
    "130-github.jsonc",
  ])
})

test("plugins domain merges by default so imported plugin arrays replace stale specs", () => {
  expect(ConfigDomain.byId.get("plugins")?.mergePolicy).toBe("merge")
})

test("post-write diagnostics settings belong to the runtime domain", () => {
  expect(ConfigDomain.domainForKey("lspWriteDiagnostics")?.id).toBe("runtime")
  expect(ConfigDomain.domainForKey("lspDiagnostics")?.id).toBe("runtime")
})

test("cortex task concurrency is owned by the runtime domain", () => {
  expect(ConfigDomain.domainForKey("cortex")?.id).toBe("runtime")
  expect(ConfigDomain.extract({ cortex: { maxConcurrentTasks: 6 } }, "runtime")).toEqual({
    cortex: { maxConcurrentTasks: 6 },
  })
})

test("GitHub shadow integration has its own canonical config domain", () => {
  const github = Config.GitHubIntegrationConfig.parse({ enabled: true })
  expect(ConfigDomain.domainForKey("github")?.id).toBe("github")
  expect(ConfigDomain.extract({ github }, "github")).toEqual({ github })
})

test("product update mode is not part of server config", async () => {
  expect(ConfigDomain.domainForKey("autoupdate")).toBeUndefined()
  expect(Object.keys(Config.Info.shape)).not.toContain("autoupdate")

  const schema = await Bun.file(new URL("../../schema/config.schema.json", import.meta.url)).json()
  expect(Object.keys(schema.properties ?? {})).not.toContain("autoupdate")
})
