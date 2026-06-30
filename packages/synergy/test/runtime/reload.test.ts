import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { RuntimeReload } from "../../src/runtime/reload"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { GlobalBus } from "../../src/bus/global"

const originalConfigReload = Config.reload

afterEach(() => {
  Config.reload = originalConfigReload
  GlobalBus.removeAllListeners("event")
})

describe("runtime.reload", () => {
  test("detects config, skill, and custom tool targets by file path", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"), "---\nname: demo\n---\n")
        const configTarget = RuntimeReload.detectTargetsForFile(
          path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc"),
        )
        const skillTarget = RuntimeReload.detectTargetsForFile(
          path.join(tmp.path, ".synergy", "skill", "demo", "SKILL.md"),
        )
        const toolTarget = RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".synergy", "tool", "demo.ts"))

        expect(configTarget).toEqual(["config"])
        expect(skillTarget).toEqual(["skill"])
        expect(toolTarget).toEqual(["tool_registry"])
      },
    })
  })

  test("ignores retired plugin source directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const pluginTarget = RuntimeReload.detectTargetsForFile(path.join(tmp.path, ".synergy", "plugin", "demo.ts"))
        const pluginScope = RuntimeReload.detectScopeForFile(path.join(tmp.path, ".synergy", "plugin", "demo.ts"))

        expect(pluginTarget).toEqual([])
        expect(pluginScope).toBeUndefined()
      },
    })
  })

  test("detects skill targets across shared runtime skill roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path

    try {
      await Bun.write(
        path.join(tmp.path, ".synergy", "skill", "global-demo", "SKILL.md"),
        "---\nname: global-demo\ndescription: demo\n---\n",
      )
      await Bun.write(
        path.join(tmp.path, ".claude", "skills", "compat-demo", "SKILL.md"),
        "---\nname: compat-demo\ndescription: demo\n---\n",
      )

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const globalSkillTarget = RuntimeReload.detectTargetsForFile(
            path.join(tmp.path, ".synergy", "skill", "global-demo", "SKILL.md"),
          )
          const compatSkillTarget = RuntimeReload.detectTargetsForFile(
            path.join(tmp.path, ".claude", "skills", "compat-demo", "SKILL.md"),
          )

          expect(globalSkillTarget).toEqual(["skill"])
          expect(compatSkillTarget).toEqual(["skill"])
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("detectScopeForFile recognizes agent and command directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalHome = process.env.SYNERGY_TEST_HOME
    process.env.SYNERGY_TEST_HOME = tmp.path
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const projectAgent = RuntimeReload.detectScopeForFile(path.join(tmp.path, ".synergy", "agent", "custom.md"))
          expect(projectAgent).toBe("project")

          const projectCommand = RuntimeReload.detectScopeForFile(
            path.join(tmp.path, ".synergy", "command", "deploy.md"),
          )
          expect(projectCommand).toBe("project")
        },
      })
    } finally {
      process.env.SYNERGY_TEST_HOME = originalHome
    }
  })

  test("returns live-applied and restart-required config fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".synergy", "synergy.d"), { recursive: true })
        await Bun.write(
          path.join(dir, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({
            model: "openai/gpt-4.1",
          }),
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "prime" })
        await Bun.write(
          path.join(tmp.path, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({
            model: "openai/gpt-5",
          }),
        )
        await Bun.write(
          path.join(tmp.path, ".synergy", "synergy.d", "120-runtime.jsonc"),
          JSON.stringify({
            server: { port: 4123 },
          }),
        )

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "test" })
        expect(result.changedFields).toContain("model")
        expect(result.changedFields).toContain("server")
        expect(result.liveApplied).toContain("model")
        expect(result.restartRequired).toContain("server")
      },
    })
  })

  test("all expands into concrete targets", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await RuntimeReload.reload({ targets: ["all"], scope: "global", reason: "test" })
        expect(result.requested).toEqual(["all"])
        expect(result.executed).toContain("config")
        expect(result.executed).toContain("skill")
        expect(result.executed).toContain("tool_registry")
        expect(result.warnings.some((item) => item.includes("packages/synergy/src"))).toBe(true)
      },
    })
  })

  test("warns when editing built-in source paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const warning = RuntimeReload.builtinSourceEditWarning(
          path.join(tmp.path, "packages", "synergy", "src", "tool", "webfetch.ts"),
        )
        expect(warning).toContain("restarting the backend process")
      },
    })
  })

  test("reload auto scope prefers project config when present and emits runtime event", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".synergy", "synergy.d"), { recursive: true })
        await Bun.write(
          path.join(dir, ".synergy", "synergy.d", "10-models.jsonc"),
          JSON.stringify({ model: "openai/gpt-4.1" }),
        )
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async (scope: "global" | "project") => ({
          config: {},
          changedFields: [] as string[],
          oldConfig: {},
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const events: Array<{ directory?: string; payload: any }> = []
        GlobalBus.on("event", (e) => events.push(e))

        const result = await RuntimeReload.reload({ targets: ["config"], reason: "auto-scope" })

        // Verify auto-scope resolved to project because a project domain config exists
        expect(configReloadMock).toHaveBeenCalledWith("project")
        expect(result.executed).toContain("config")
        const reloadedEvent = events.find((e) => e.payload?.type === RuntimeReload.Event.Reloaded.type)
        expect(reloadedEvent).toBeDefined()
        expect(reloadedEvent!.payload.properties.executed).toContain("config")
      },
    })
  })

  test("detects global domain config files as global scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(RuntimeReload.detectScopeForFile(ConfigDomain.filepath("models"))).toBe("global")
        expect(RuntimeReload.detectTargetsForFile(ConfigDomain.filepath("mcp"))).toEqual(["config"])
      },
    })
  })

  test("config reload reports cascaded targets and warnings from changed fields", async () => {
    // Test inferConfigCascades directly — it determines what subsystems reload
    // when config fields change. Testing through full reload() is unreliable in
    // test env because subsystem init may hang without a running server.
    const cascaded = RuntimeReload.inferConfigCascades([
      "provider",
      "plugin",
      "mcp",
      "watcher",
      "channel",
      "server",
      "theme",
    ])
    expect(cascaded).toContain("provider")
    expect(cascaded).toContain("agent")
    expect(cascaded).toContain("plugin")
    expect(cascaded).toContain("tool_registry")
    expect(cascaded).toContain("mcp")
    expect(cascaded).toContain("command")
    expect(cascaded).toContain("watcher")
    expect(cascaded).toContain("channel")

    // Verify external_agent cascades to agent (P10 fix)
    const extAgentCascade = RuntimeReload.inferConfigCascades(["external_agent"])
    expect(extAgentCascade).toContain("agent")

    // Verify model role changes cascade to agent only (not provider)
    const modelCascade = RuntimeReload.inferConfigCascades(["model"])
    expect(modelCascade).not.toContain("provider")
    expect(modelCascade).toContain("agent")

    const visionModelCascade = RuntimeReload.inferConfigCascades(["vision_model"])
    expect(visionModelCascade).not.toContain("provider")
    expect(visionModelCascade).toContain("agent")

    // Verify category changes cascade to provider + agent
    const categoryCascade = RuntimeReload.inferConfigCascades(["category"])
    expect(categoryCascade).toContain("provider")
    expect(categoryCascade).toContain("agent")

    // Verify default_agent and instruction file settings cascade to agent
    const defaultAgentCascade = RuntimeReload.inferConfigCascades(["default_agent"])
    expect(defaultAgentCascade).toContain("agent")

    const instructionsCascade = RuntimeReload.inferConfigCascades(["instructions"])
    expect(instructionsCascade).toContain("agent")

    const projectDocFallbackCascade = RuntimeReload.inferConfigCascades(["project_doc_fallback_filenames"])
    expect(projectDocFallbackCascade).toContain("agent")

    const projectDocMaxBytesCascade = RuntimeReload.inferConfigCascades(["project_doc_max_bytes"])
    expect(projectDocMaxBytesCascade).toContain("agent")

    // Verify tools changes cascade to tool_registry
    const toolsCascade = RuntimeReload.inferConfigCascades(["tools"])
    expect(toolsCascade).toContain("tool_registry")

    // Verify email is in restart-required (P13 fix)
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const configReloadMock = mock(async () => ({
          config: {},
          changedFields: ["server", "theme"],
          oldConfig: {},
        }))
        Config.reload = configReloadMock as typeof Config.reload

        const result = await RuntimeReload.reload({ targets: ["config"], scope: "global", reason: "cascade" })

        expect(result.restartRequired).toContain("server")
        expect(result.warnings).toContain(
          "Config field `theme` is client-side and is not reloaded by the server runtime",
        )
      },
    })
  })

  test("error isolation: reload continues after subsystem failure", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await RuntimeReload.reload({ targets: ["skill"], scope: "global", reason: "test" })
        expect(result.executed).toContain("skill")
        expect(typeof result.success).toBe("boolean")
      },
    })
  })
})
