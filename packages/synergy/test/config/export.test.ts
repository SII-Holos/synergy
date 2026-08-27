import { describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { ConfigExport } from "../../src/config/export"
import { ConfigImport } from "../../src/config/import"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

async function withProject<T>(fn: (input: { project: string; root: string }) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  return ScopeContext.provide({
    scope,
    fn: () => fn({ project: tmp.path, root: path.join(tmp.path, ".synergy") }),
  })
}

function mcpOf(config: Config.Info) {
  return (config.mcp ?? {}) as Record<string, any>
}

describe("config export", () => {
  test("redacts api keys and secrets by default", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "providers",
        {
          provider: {
            custom: { name: "Custom", options: { apiKey: "plain-secret", baseURL: "https://x" }, models: {} },
          },
        },
        { root, mode: "replace-domain" },
      )
      await Config.domainUpdate(
        "general",
        { username: "someone", embedding: { baseURL: "https://e", model: "m", apiKey: "embed-key" } },
        { root, mode: "replace-domain" },
      )

      const result = await ConfigExport.build({ scope: "project" })

      expect(result.config.provider?.custom?.options?.apiKey).toBe(Config.REDACTED_SENTINEL)
      expect(result.config.embedding?.apiKey).toBe(Config.REDACTED_SENTINEL)
      expect(result.config.username).toBe("someone")
      expect(result.secretsIncluded).toBe(false)
      expect(result.domains).toEqual(expect.arrayContaining(["providers", "general"]))
    })
  })

  test("redacts mcp headers, mcp environment, and agent option secrets by default", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "mcp",
        {
          mcp: {
            remote: {
              type: "remote",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer header-secret", "X-Custom": "not-a-secret" },
            },
            local: {
              type: "local",
              command: ["node", "server.js"],
              environment: { ANTHROPIC_API_KEY: "env-secret", NODE_ENV: "production" },
            },
          },
        },
        { root, mode: "replace-domain" },
      )
      await Config.domainUpdate(
        "agents",
        { agent: { worker: { model: "anthropic/claude-sonnet-4-5", options: { GITHUB_TOKEN: "agent-secret" } } } },
        { root, mode: "replace-domain" },
      )

      const result = await ConfigExport.build({ scope: "project" })

      expect(mcpOf(result.config).remote.headers.Authorization).toBe(Config.REDACTED_SENTINEL)
      expect(mcpOf(result.config).remote.headers["X-Custom"]).toBe("not-a-secret")
      expect(mcpOf(result.config).local.environment.ANTHROPIC_API_KEY).toBe(Config.REDACTED_SENTINEL)
      expect(mcpOf(result.config).local.environment.NODE_ENV).toBe("production")
      expect(result.config.agent?.worker?.options?.GITHUB_TOKEN).toBe(Config.REDACTED_SENTINEL)
    })
  })

  test("keeps plaintext secrets when includeSecrets is true", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "providers",
        { provider: { custom: { name: "Custom", options: { apiKey: "plain-secret" }, models: {} } } },
        { root, mode: "replace-domain" },
      )

      const result = await ConfigExport.build({ scope: "project", includeSecrets: true })

      expect(result.config.provider?.custom?.options?.apiKey).toBe("plain-secret")
      expect(result.secretsIncluded).toBe(true)
    })
  })

  test("redacted export round-trips through import and restores stored secrets", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "providers",
        { provider: { custom: { name: "Custom", options: { apiKey: "stored-secret" }, models: {} } } },
        { root, mode: "replace-domain" },
      )
      const exported = await ConfigExport.build({ scope: "project" })
      expect(exported.config.provider?.custom?.options?.apiKey).toBe(Config.REDACTED_SENTINEL)

      await ConfigImport.apply({ config: exported.config, scope: "project", yes: true })
      expect(await Config.domainGet("providers", root)).toMatchObject({
        provider: { custom: { options: { apiKey: "stored-secret" } } },
      })
    })
  })

  test("redacted mcp header and environment secrets round-trip through import", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "mcp",
        {
          mcp: {
            remote: {
              type: "remote",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer header-secret" },
            },
            local: {
              type: "local",
              command: ["node", "server.js"],
              environment: { ANTHROPIC_API_KEY: "env-secret" },
            },
          },
        },
        { root, mode: "replace-domain" },
      )

      const exported = await ConfigExport.build({ scope: "project" })
      expect(mcpOf(exported.config).remote.headers.Authorization).toBe(Config.REDACTED_SENTINEL)
      expect(mcpOf(exported.config).local.environment.ANTHROPIC_API_KEY).toBe(Config.REDACTED_SENTINEL)

      await ConfigImport.apply({ config: exported.config, scope: "project", yes: true })
      const stored = await Config.domainGet("mcp", root)
      expect(mcpOf(stored).remote.headers.Authorization).toBe("Bearer header-secret")
      expect(mcpOf(stored).local.environment.ANTHROPIC_API_KEY).toBe("env-secret")
    })
  })

  test("only exports the selected domains", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("models", { model: "test/model" }, { root, mode: "replace-domain" })
      await Config.domainUpdate("general", { username: "someone" }, { root, mode: "replace-domain" })

      const result = await ConfigExport.build({ scope: "project", only: ["models"] })

      expect(result.domains).toEqual(["models"])
      expect(result.config.model).toBe("test/model")
      expect(result.config.username).toBeUndefined()
    })
  })

  test("rejects project scope without an active project", async () => {
    await expect(ConfigExport.build({ scope: "project" })).rejects.toMatchObject({
      name: "ConfigImportProjectScopeRequiredError",
    })
  })

  test("omits $schema and undefined domains", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("models", { model: "test/model" }, { root, mode: "replace-domain" })

      const result = await ConfigExport.build({ scope: "project" })

      // Export output must stay machine-independent: the runtime's only
      // schema URL is the install-local file:// path, which is a broken
      // link on any other machine.
      expect(result.config.$schema).toBeUndefined()
      expect(result.config.provider).toBeUndefined()
      expect(result.domains).toEqual(["models"])
    })
  })

  test("skips a broken domain file with a warning instead of quarantining it", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("models", { model: "test/model" }, { root, mode: "replace-domain" })
      const filepath = path.join(root, "synergy.d", "00-general.jsonc")
      await Bun.write(filepath, "{ this is not valid json")

      const result = await ConfigExport.build({ scope: "project" })

      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0]).toContain("general")
      expect(result.domains).not.toContain("general")
      expect(await Bun.file(filepath).text()).toContain("not valid json")
    })
  })

  test("exports plugin specs relative to the config directory", async () => {
    await withProject(async ({ root }) => {
      await Bun.write(
        path.join(root, "synergy.d", "50-plugins.jsonc"),
        JSON.stringify({ plugin: ["./dev-plugins/foo"] }),
      )

      const result = await ConfigExport.build({ scope: "project" })

      expect(result.config.plugin).toEqual(["./dev-plugins/foo"])
    })
  })
})
