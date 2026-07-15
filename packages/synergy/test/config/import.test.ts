import { describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { ConfigImport } from "../../src/config/import"
import { Global } from "../../src/global"
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

describe("config import planning", () => {
  test("classifies additions, modifications, removals, and conflicts", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate(
        "models",
        { model: "test/old", quick_switcher: { models: [{ providerID: "test", modelID: "old", state: "add" }] } },
        { root, mode: "replace-domain" },
      )

      const plan = await ConfigImport.plan({
        config: { model: "test/new" },
        scope: "project",
        mode: "replace-domain",
        source: "pasted",
      })

      expect(plan.scope).toBe("project")
      expect(plan.source).toBe("pasted")
      expect(plan.revision).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.domains).toHaveLength(1)
      expect(plan.domains[0]!.revision).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.domains[0]!.changes).toEqual([
        expect.objectContaining({
          key: "model",
          type: "modify",
          conflict: true,
          before: "test/old",
          after: "test/new",
        }),
        expect.objectContaining({
          key: "quick_switcher",
          type: "remove",
          conflict: false,
          before: { models: [{ providerID: "test", modelID: "old", state: "add" }] },
        }),
      ])
      expect(plan.conflicts).toEqual([expect.objectContaining({ key: "model", type: "modify" })])
    })
  })

  test("uses the explicit project scope root without touching global paths", async () => {
    await withProject(async ({ project }) => {
      const plan = await ConfigImport.plan({ config: { model: "test/project" }, scope: "project" })
      expect(plan.domains[0]!.path).toBe(path.join(project, ".synergy", "synergy.d", "10-models.jsonc"))
      expect(plan.domains[0]!.path.startsWith(Global.Path.config)).toBe(false)
    })
  })

  test("defaults to global scope and global domain paths", async () => {
    const plan = await ConfigImport.plan({ config: { model: "test/global" } })
    expect(plan.scope).toBe("global")
    expect(plan.domains[0]!.path).toBe(ConfigDomain.filepath("models"))
  })

  test("rejects project scope without an active project", async () => {
    await expect(ConfigImport.plan({ config: { model: "test/project" }, scope: "project" })).rejects.toMatchObject({
      name: "ConfigImportProjectScopeRequiredError",
    })
  })

  test("redacts secret values and warns about hardcoded imported secrets", async () => {
    await withProject(async () => {
      const plan = await ConfigImport.plan({
        scope: "project",
        config: {
          provider: {
            custom: {
              name: "Custom",
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "plain-secret" },
              models: {},
            },
          },
        },
      })

      const change = plan.domains[0]!.changes.find((item) => item.key === "provider")!
      expect(change.after).toEqual(
        expect.objectContaining({
          custom: expect.objectContaining({ options: { apiKey: Config.REDACTED_SENTINEL } }),
        }),
      )
      expect(change.diagnostics).toContainEqual(
        expect.objectContaining({ code: "config.import.hardcoded_secret", severity: "warning" }),
      )
    })
  })
})

describe("config import apply", () => {
  test("writes project domains and preserves unrelated domain files", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("plugins", { plugin: ["example-plugin"] }, { root, mode: "replace-domain" })
      const pluginPath = ConfigDomain.filepath("plugins", root)
      const pluginBefore = await Bun.file(pluginPath).text()
      const plan = await ConfigImport.plan({ config: { model: "test/new" }, scope: "project" })

      const result = await ConfigImport.apply({
        config: { model: "test/new" },
        scope: "project",
        revision: plan.revision,
        yes: true,
      })

      expect(result.plan.revision).toBe(plan.revision)
      expect(await Config.domainGet("models", root)).toMatchObject({ model: "test/new" })
      expect(await Bun.file(pluginPath).text()).toBe(pluginBefore)
    })
  })

  test("returns scoped reload results after the commit", async () => {
    await withProject(async ({ root }) => {
      const result = await ConfigImport.apply({
        config: { username: "imported-user" },
        scope: "project",
        yes: true,
      })

      expect(await Config.domainGet("general", root)).toMatchObject({ username: "imported-user" })
      expect(result.reload).toMatchObject({
        success: true,
        executed: expect.arrayContaining(["config"]),
        changedFields: expect.arrayContaining(["username"]),
        liveApplied: expect.arrayContaining(["username"]),
      })
    })
  })

  test("rejects a concurrent apply to the same scope", async () => {
    await withProject(async () => {
      const entered = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const first = ConfigImport.apply(
        { config: { username: "first" }, scope: "project", yes: true },
        {
          beforeCommitDomain: async () => {
            entered.resolve()
            await proceed.promise
          },
        },
      )
      await entered.promise

      await expect(
        ConfigImport.apply({ config: { username: "second" }, scope: "project", yes: true }),
      ).rejects.toMatchObject({ name: "ConfigImportLockedError" })

      proceed.resolve()
      await first
    })
  })

  test("rolls back prior domain writes when a later commit fails", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("general", { username: "before" }, { root, mode: "replace-domain" })
      await Config.domainUpdate("models", { model: "test/before" }, { root, mode: "replace-domain" })
      const generalPath = ConfigDomain.filepath("general", root)
      const modelsPath = ConfigDomain.filepath("models", root)
      const before = await Promise.all([Bun.file(generalPath).text(), Bun.file(modelsPath).text()])

      await expect(
        ConfigImport.apply(
          {
            config: { username: "after", model: "test/after" },
            scope: "project",
            yes: true,
          },
          {
            beforeCommitDomain: async (_domain, index) => {
              if (index === 1) throw new Error("simulated commit failure")
            },
          },
        ),
      ).rejects.toThrow("simulated commit failure")

      expect(await Bun.file(generalPath).text()).toBe(before[0])
      expect(await Bun.file(modelsPath).text()).toBe(before[1])
    })
  })

  test("preserves JSONC comments while updating a domain", async () => {
    await withProject(async ({ root }) => {
      const filepath = ConfigDomain.filepath("models", root)
      await Bun.write(filepath, '{\n  // keep this model note\n  "model": "test/before",\n}\n')

      await ConfigImport.apply({
        config: { model: "test/after" },
        scope: "project",
        yes: true,
      })

      const content = await Bun.file(filepath).text()
      expect(content).toContain("// keep this model note")
      expect(content).toContain('"model": "test/after"')
    })
  })

  test("rejects a stale plan before writing any domain", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("models", { model: "test/original" }, { root, mode: "replace-domain" })
      const plan = await ConfigImport.plan({ config: { model: "test/imported" }, scope: "project" })
      await Config.domainUpdate("models", { model: "test/concurrent" }, { root, mode: "replace-domain" })

      await expect(
        ConfigImport.apply({
          config: { model: "test/imported" },
          scope: "project",
          revision: plan.revision,
          yes: true,
        }),
      ).rejects.toMatchObject({ name: "ConfigImportRevisionConflictError" })
      expect(await Config.domainGet("models", root)).toMatchObject({ model: "test/concurrent" })
    })
  })

  test("force bypasses a stale revision", async () => {
    await withProject(async ({ root }) => {
      await Config.domainUpdate("models", { model: "test/original" }, { root, mode: "replace-domain" })
      const plan = await ConfigImport.plan({ config: { model: "test/imported" }, scope: "project" })
      await Config.domainUpdate("models", { model: "test/concurrent" }, { root, mode: "replace-domain" })

      await ConfigImport.apply({
        config: { model: "test/imported" },
        scope: "project",
        revision: plan.revision,
        yes: true,
        force: true,
      })
      expect(await Config.domainGet("models", root)).toMatchObject({ model: "test/imported" })
    })
  })
})

describe("config import sources", () => {
  test("parses JSONC comments and trailing commas", () => {
    expect(ConfigImport.parseSourceText('{ /* comment */ "model": "test/model", }', "pasted")).toMatchObject({
      model: "test/model",
    })
  })

  test("rejects source text larger than one MiB before parsing", () => {
    expect(() =>
      ConfigImport.parseSourceText(`{"username":"${"x".repeat(ConfigImport.MAX_SOURCE_BYTES)}"}`, "large.jsonc"),
    ).toThrow("CONFIG_TOO_LARGE")
  })
})
